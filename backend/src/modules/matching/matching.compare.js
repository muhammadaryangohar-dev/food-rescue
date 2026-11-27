// Weight comparison (proposal CP3: "Alternative weight settings will be compared in
// the evaluation").
//
// For each weight set, the REAL matching engine runs against the REAL current data,
// inside a transaction that holds the allocation lock and is then ALWAYS rolled
// back. Whatever the engine does (allocations, notifications, decision rows), nothing
// is ever saved: the rollback is enforced here, not trusted to the engine.
// The allocations the engine would have created are read back inside the
// transaction just before the rollback and summarised side by side.
import { prisma, TX_OPTIONS } from '../../lib/prisma.js';
import { takeAllocationLock } from '../../lib/lock.js';
import { getNumber } from '../../lib/config.js';
import { AppError } from '../../lib/errors.js';
import { getMatchingRunner } from './matching.trigger.js';

export const WEIGHT_KEYS = {
  freshness: 'WEIGHT_FRESHNESS',
  feasibility: 'WEIGHT_FEASIBILITY',
  quantityFit: 'WEIGHT_QUANTITY_FIT',
  proximity: 'WEIGHT_PROXIMITY',
  fairness: 'WEIGHT_FAIRNESS',
};

class DryRunRollback extends Error {
  constructor(result) {
    super('dry run finished (rolled back)');
    this.result = result;
  }
}

async function currentWeights() {
  const w = {};
  for (const [name, key] of Object.entries(WEIGHT_KEYS)) w[name] = await getNumber(key);
  return w;
}

function summarise(created) {
  const perNgo = new Map();
  for (const a of created) {
    const key = a.request.ngo.id;
    const row = perNgo.get(key) || { ngoId: key, ngo: a.request.ngo.name, servings: 0, allocations: 0 };
    row.servings += a.quantity;
    row.allocations += 1;
    perNgo.set(key, row);
  }
  const ngos = [...perNgo.values()].sort((x, y) => y.servings - x.servings);
  const servings = ngos.map((n) => n.servings);
  const now = Date.now();
  const hoursLeft = created.map((a) => (new Date(a.listing.safeUntil).getTime() - now) / 3600_000);
  const scores = created.map((a) => a.score).filter((s) => typeof s === 'number');
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
  return {
    allocations: created.length,
    totalServings: servings.reduce((s, x) => s + x, 0),
    ngosServed: ngos.length,
    // Lower spread = food shared more evenly between NGOs
    fairnessSpread: servings.length ? Math.max(...servings) - Math.min(...servings) : 0,
    // Lower = the engine rescued food that was closer to expiry first
    avgHoursToSafeUntil: avg(hoursLeft),
    avgScore: avg(scores),
    perNgo: ngos,
    pairs: created.map((a) => ({ listingId: a.listingId, requestId: a.requestId, ngo: a.request.ngo.name, quantity: a.quantity, score: a.score })),
  };
}

async function dryRun(runner, weights) {
  try {
    await prisma.$transaction(async (tx) => {
      await takeAllocationLock(tx);
      const before = await tx.allocation.aggregate({ _max: { id: true } });
      await runner({ reason: 'weight-comparison (dry run)', tx, weights, dryRun: true });
      const created = await tx.allocation.findMany({
        where: { id: { gt: before._max.id ?? 0 } },
        include: { request: { select: { ngo: { select: { id: true, name: true } } } }, listing: { select: { safeUntil: true } } },
        orderBy: { id: 'asc' },
      });
      throw new DryRunRollback(summarise(created)); // forces the rollback
    }, TX_OPTIONS);
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
  throw new Error('Dry run did not roll back'); // unreachable
}

/**
 * Compare the current config weights against up to 4 alternative weight sets.
 * weightSets: [{ name, weights: { freshness, feasibility, quantityFit, proximity, fairness } }]
 */
export async function compareWeights(weightSets = []) {
  const runner = getMatchingRunner();
  if (!runner) throw new AppError(501, 'NOT_AVAILABLE', 'The matching engine is not installed yet (Member 2), so there is nothing to compare.');

  const sets = [{ name: 'Current settings', weights: await currentWeights() }, ...weightSets];
  const results = [];
  for (const set of sets) {
    results.push({ name: set.name, weights: set.weights, ...(await dryRun(runner, set.weights)) });
  }
  return { savedAnything: false, comparedAt: new Date().toISOString(), results };
}

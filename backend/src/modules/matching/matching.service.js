// Matching engine (M5, Member 2): the Perishability-Aware Allocation Engine.
//
// One run looks at ALL open listings and ALL open requests together:
//   1. Stage 1 filters every (listing, request) pair with hard rules (matching.rules.js).
//   2. Stage 2 scores each eligible pair out of 100.
//   3. Greedy loop with pooling: repeatedly take the best pair, offer the smaller of
//      what the listing has left and what the request still needs, update quantities,
//      capacity and fairness, re-score, and repeat. One request can be filled from
//      several donors and one listing can be split across several NGOs.
//   4. Every pair considered is written to match_decisions ("Why wasn't I matched?").
//
// Greedy is not optimal, by design: it is fast and every choice can be explained.
// Offers are created with Member 1's createAllocationLocked(), which re-checks every
// rule and the derived quantities inside the lock, so the engine cannot over-allocate.
import crypto from 'node:crypto';
import { registerMatchingRunner, triggerMatching } from './matching.trigger.js';
import { checkPair, scorePair, giveQuantity, explain, comparePairs, WEIGHT_NAMES } from './matching.rules.js';
import { withAllocationLock } from '../../lib/lock.js';
import { createAllocationLocked, declinedPairs } from '../allocations/allocation.service.js';
import { sweepLocked } from '../allocations/sweep.service.js';
import { listingQuantities, requestQuantities, REQUEST_COVERING } from '../../lib/quantities.js';
import { getNumber } from '../../lib/config.js';
import { pkDayRange } from '../../lib/time.js';
import { receivedByNgo, windowStart } from '../fairness/fairness.ledger.js';

// Offers per run. Each offer is about 10 database round trips (~3 s to Neon from
// Pakistan) inside the allocation lock, so a long run could pass the 60 s transaction
// limit and block accepts and pickups meanwhile. When the cap is hit, another run is
// queued straight away for the rest.
export const MAX_OFFERS_PER_RUN = 8;
// match_decisions rows older than this are deleted at the start of a run.
const DECISION_KEEP_HOURS = 24;

const WEIGHT_KEYS = {
  freshness: 'WEIGHT_FRESHNESS',
  feasibility: 'WEIGHT_FEASIBILITY',
  quantityFit: 'WEIGHT_QUANTITY_FIT',
  proximity: 'WEIGHT_PROXIMITY',
  fairness: 'WEIGHT_FAIRNESS',
};

/**
 * Entry point registered with matching.trigger.js.
 * If `tx` is given the caller already holds the allocation lock (weight comparison):
 * use it and never open a second lock.
 */
export async function runMatching({ reason = 'manual', tx, weights, dryRun = false } = {}) {
  if (tx) return match(tx, { reason, weights, dryRun });
  const result = await withAllocationLock((lockedTx) => match(lockedTx, { reason, weights, dryRun }));
  // Cap reached and more pairs were waiting: queue another run (after this lock is released)
  if (result.more && !dryRun) triggerMatching('more-to-match');
  return result;
}

/**
 * Weights from the override or SystemConfig, scaled so they always add up to 100.
 * An admin can change one weight at a time in the settings panel, so the stored five
 * may not add up to 100; scaling keeps every score "out of 100" anyway.
 */
async function loadWeights(tx, override) {
  const raw = {};
  if (override) for (const n of WEIGHT_NAMES) raw[n] = Math.max(0, Number(override[n]) || 0);
  else for (const [name, key] of Object.entries(WEIGHT_KEYS)) raw[name] = Math.max(0, await getNumber(key, tx));
  const total = WEIGHT_NAMES.reduce((t, n) => t + raw[n], 0);
  if (total === 0) return Object.fromEntries(WEIGHT_NAMES.map((n) => [n, 20])); // all zero: equal weights
  return Object.fromEntries(WEIGHT_NAMES.map((n) => [n, Math.round((raw[n] * 100 * 100) / total) / 100]));
}

const dayKey = (ngoId, at) => `${ngoId}:${pkDayRange(at).start.getTime()}`;

async function match(tx, { reason, weights: override, dryRun }) {
  const now = new Date();
  await sweepLocked(tx, now);

  const weights = await loadWeights(tx, override);
  const cfg = {
    minAllocation: await getNumber('MIN_ALLOCATION_SERVINGS', tx),
    nearExpiryHours: await getNumber('NEAR_EXPIRY_HOURS', tx),
    nearExpiryKm: await getNumber('NEAR_EXPIRY_RADIUS_KM', tx),
    speedKmh: await getNumber('AVERAGE_SPEED_KMH', tx),
  };
  const runId = `run-${now.toISOString()}-${crypto.randomBytes(3).toString('hex')}`;
  cfg.responseMinutes = await getNumber('OFFER_RESPONSE_MINUTES', tx);

  // Housekeeping: the decision log only needs recent runs ("Why wasn't I matched?")
  if (!dryRun) await tx.matchDecision.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DECISION_KEEP_HOURS * 3_600_000) } } });

  // ---- load everything once (few queries: Neon is ~0.3 s per round trip)
  const listingRows = await tx.surplusListing.findMany({
    where: { status: 'OPEN', safeUntil: { gt: now }, collectionDeadline: { gt: now } },
    include: { organisation: true, category: true },
  });
  const requestRows = await tx.nGORequest.findMany({
    where: { status: 'OPEN', requiredBy: { gt: now } },
    include: { ngo: true, category: true },
  });
  const lq = await listingQuantities(tx, listingRows);
  const rq = await requestQuantities(tx, requestRows);
  const listings = listingRows.filter((l) => lq.get(l.id).remaining > 0);
  const requests = requestRows.filter((r) => rq.get(r.id).remainingNeed > 0);
  if (listings.length === 0 || requests.length === 0) {
    return { runId, reason, considered: 0, eligible: 0, offers: 0, servings: 0, message: 'Nothing to match: no open food or no open need.' };
  }

  const remaining = new Map(listings.map((l) => [l.id, lq.get(l.id).remaining]));
  const need = new Map(requests.map((r) => [r.id, rq.get(r.id).remainingNeed]));

  // Pairs the NGO declined (rejected, cancelled itself, or never answered) are never offered again
  const declined = await declinedPairs(tx, { listingIds: listings.map((l) => l.id) });

  // NGO daily capacity: servings already offered / accepted / delivered for that day
  const ngoIds = [...new Set(requests.map((r) => r.ngoId))];
  const days = requests.map((r) => pkDayRange(r.requiredBy));
  const covering = await tx.allocation.findMany({
    where: {
      status: { in: REQUEST_COVERING },
      request: { ngoId: { in: ngoIds }, requiredBy: { gte: new Date(Math.min(...days.map((d) => +d.start))), lt: new Date(Math.max(...days.map((d) => +d.end))) } },
    },
    select: { quantity: true, lostQuantity: true, request: { select: { ngoId: true, requiredBy: true } } },
  });
  const used = new Map();
  for (const a of covering) {
    const k = dayKey(a.request.ngoId, a.request.requiredBy);
    used.set(k, (used.get(k) || 0) + a.quantity - a.lostQuantity);
  }
  const capacityLeft = (r) => (r.ngo.dailyCapacity ? Math.max(0, r.ngo.dailyCapacity - (used.get(dayKey(r.ngoId, r.requiredBy)) || 0)) : null);

  // Fairness: servings each NGO received in the last 7 days (updated as the run offers food)
  const received = await receivedByNgo(tx, { since: windowStart(now) });
  const maxReceived = () => Math.max(0, ...received.values());

  const ctxFor = (l, r) => ({
    now,
    cfg,
    weights,
    remaining: remaining.get(l.id),
    remainingNeed: need.get(r.id),
    capacityLeft: capacityLeft(r),
    declined: declined.has(`${l.id}:${r.id}`),
    received: received.get(r.ngoId) || 0,
    maxReceived: maxReceived(),
  });

  // ---- stage 1 + first stage-2 score for every pair
  const decisions = new Map(); // key -> decision row
  let candidates = [];
  for (const l of listings) {
    for (const r of requests) {
      const key = `${l.id}:${r.id}`;
      const ctx = ctxFor(l, r);
      const check = checkPair(l, r, ctx);
      if (!check.ok) {
        decisions.set(key, { runId, listingId: l.id, requestId: r.id, eligible: false, rejectionReason: check.reason });
        continue;
      }
      const s = scorePair(l, r, check, ctx);
      decisions.set(key, { runId, listingId: l.id, requestId: r.id, eligible: true, score: s.score, scoreBreakdown: s.breakdown });
      candidates.push({ key, listing: l, request: r, check, score: s.score });
    }
  }
  const eligibleCount = candidates.length;

  // ---- greedy loop with pooling
  const offers = [];
  let more = false;
  while (candidates.length > 0) {
    if (offers.length >= MAX_OFFERS_PER_RUN) {
      more = true;
      break;
    }
    // Re-check and re-score: quantities, capacity and fairness changed after the last offer
    const live = [];
    for (const c of candidates) {
      const ctx = ctxFor(c.listing, c.request);
      if (giveQuantity(ctx) <= 0) continue;
      const check = checkPair(c.listing, c.request, ctx);
      if (!check.ok) continue;
      const s = scorePair(c.listing, c.request, check, ctx);
      live.push({ ...c, check, score: s.score, breakdown: s.breakdown, give: s.give });
    }
    if (live.length === 0) break;
    live.sort(comparePairs);
    const best = live[0];
    candidates = live.slice(1);

    const ctx = ctxFor(best.listing, best.request);
    const quantity = best.give;
    // Below the minimum is only allowed when it uses up the listing or fills the need
    if (quantity < cfg.minAllocation && quantity !== ctx.remaining && quantity !== ctx.remainingNeed) continue;

    const explanation = explain(best.score, best.breakdown, quantity, ctx.remainingNeed);
    try {
      const allocation = await createAllocationLocked(tx, {
        listingId: best.listing.id,
        requestId: best.request.id,
        quantity,
        score: best.score,
        scoreBreakdown: best.breakdown,
        explanation,
        now,
      });
      offers.push({ allocationId: allocation.id, listingId: best.listing.id, requestId: best.request.id, ngo: best.request.ngo.name, quantity, score: best.score });
      remaining.set(best.listing.id, remaining.get(best.listing.id) - quantity);
      need.set(best.request.id, need.get(best.request.id) - quantity);
      const k = dayKey(best.request.ngoId, best.request.requiredBy);
      used.set(k, (used.get(k) || 0) + quantity);
      received.set(best.request.ngoId, (received.get(best.request.ngoId) || 0) + quantity);
    } catch (err) {
      // Member 1's re-check refused it (e.g. a rule changed mid-run): skip this pair only
      const d = decisions.get(best.key);
      decisions.set(best.key, { ...d, eligible: false, score: null, scoreBreakdown: null, rejectionReason: `the final safety re-check refused it: ${err.message}` });
    }
  }

  const rows = [...decisions.values()];
  await tx.matchDecision.createMany({ data: rows });

  const result = {
    runId,
    reason,
    dryRun,
    considered: rows.length,
    eligible: eligibleCount,
    offers: offers.length,
    servings: offers.reduce((s, o) => s + o.quantity, 0),
    more,
    allocations: offers,
  };
  if (!dryRun && process.env.NODE_ENV === 'development') {
    console.log(`[matching] ${reason}: ${result.considered} pairs, ${result.eligible} eligible, ${result.offers} offers (${result.servings} servings)`);
  }
  return result;
}

registerMatchingRunner(runMatching);

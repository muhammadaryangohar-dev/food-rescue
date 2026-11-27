// Fairness ledger and view (M10, Member 2).
//
// Shows how food was shared between NGOs over a window (default 7 days, the same window
// the matching engine's fairness score uses):
//   - servings each NGO received (verified deliveries) and its share
//   - the fairness value the engine would give it now (1 - received / most received)
//   - servings per person served, so a big kitchen and a small orphanage compare fairly
//   - offers still on their way (proposed / accepted / picked up)
//   - Member 1's reliability score (how the NGO answers offers)
// plus whole-platform numbers: Gini coefficient (0 = perfectly even, 1 = one NGO got
// everything) and the gap between the most and least served NGO.
import { prisma } from '../../lib/prisma.js';
import { IN_PROGRESS } from '../../lib/quantities.js';
import { getNumber } from '../../lib/config.js';
import { ngoReliability } from '../tracking/reliability.service.js';
import { receivedByNgo, windowStart, FAIRNESS_WINDOW_DAYS } from './fairness.ledger.js';

/** Gini coefficient of a list of non-negative numbers (0 = equal shares). */
export function gini(values) {
  const n = values.length;
  const total = values.reduce((s, v) => s + v, 0);
  if (n === 0 || total === 0) return 0;
  let diff = 0;
  for (const a of values) for (const b of values) diff += Math.abs(a - b);
  return Math.round((diff / (2 * n * total)) * 1000) / 1000;
}

export async function fairnessLedger({ days = FAIRNESS_WINDOW_DAYS } = {}) {
  const now = new Date();
  const ngos = await prisma.organisation.findMany({
    where: { type: 'NGO', verificationStatus: 'VERIFIED' },
    select: { id: true, name: true, area: true, ngoType: true, dailyCapacity: true, beneficiaries: true },
    orderBy: { name: 'asc' },
  });
  const ids = ngos.map((n) => n.id);
  const received = await receivedByNgo(prisma, { since: windowStart(now, days), ngoIds: ids });
  const pendingRows = await prisma.allocation.groupBy({
    by: ['requestId'],
    where: { status: { in: IN_PROGRESS }, request: { ngoId: { in: ids } } },
    _sum: { quantity: true },
  });
  const reqNgo = new Map(
    (await prisma.nGORequest.findMany({ where: { id: { in: pendingRows.map((p) => p.requestId) } }, select: { id: true, ngoId: true } })).map((r) => [r.id, r.ngoId]),
  );
  const pending = new Map();
  for (const p of pendingRows) {
    const ngoId = reqNgo.get(p.requestId);
    pending.set(ngoId, (pending.get(ngoId) || 0) + (p._sum.quantity || 0));
  }
  const reliability = new Map((await ngoReliability({ organisationIds: ids })).map((r) => [r.organisationId, r]));
  const weight = await getNumber('WEIGHT_FAIRNESS');

  const values = ids.map((id) => received.get(id) || 0);
  const total = values.reduce((s, v) => s + v, 0);
  const max = Math.max(0, ...values);

  const rows = ngos
    .map((n) => {
      const got = received.get(n.id) || 0;
      const fairnessValue = max > 0 ? 1 - got / max : 1;
      const rel = reliability.get(n.id);
      return {
        ngoId: n.id,
        name: n.name,
        area: n.area,
        ngoType: n.ngoType,
        beneficiaries: n.beneficiaries,
        dailyCapacity: n.dailyCapacity,
        received: got,
        sharePercent: total ? Math.round((got / total) * 1000) / 10 : 0,
        servingsPerPerson: n.beneficiaries ? Math.round((got / n.beneficiaries) * 10) / 10 : null,
        onTheWay: pending.get(n.id) || 0,
        fairnessValue: Math.round(fairnessValue * 100) / 100,
        fairnessPoints: Math.round(fairnessValue * weight * 10) / 10,
        reliability: rel ? { score: rel.score, level: rel.level } : null,
      };
    })
    .sort((a, b) => a.received - b.received || a.name.localeCompare(b.name));

  const byType = new Map();
  for (const r of rows) {
    const t = byType.get(r.ngoType || 'OTHER') || { ngoType: r.ngoType || 'OTHER', ngos: 0, received: 0 };
    t.ngos += 1;
    t.received += r.received;
    byType.set(t.ngoType, t);
  }

  return {
    windowDays: days,
    from: windowStart(now, days).toISOString(),
    to: now.toISOString(),
    summary: {
      ngos: rows.length,
      ngosServed: values.filter((v) => v > 0).length,
      totalReceived: total,
      gini: gini(values),
      mostReceived: max,
      leastReceived: values.length ? Math.min(...values) : 0,
      fairnessWeight: weight,
    },
    byType: [...byType.values()].sort((a, b) => b.received - a.received),
    ngos: rows,
    explanation:
      `The matching engine gives each NGO up to ${weight} fairness points: the NGO that received the most in the last ${days} days gets 0, ` +
      'an NGO that received nothing gets all of them. Rows are listed least-served first.',
  };
}

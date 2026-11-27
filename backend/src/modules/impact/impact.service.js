// Impact and analytics (M9, Member 2). Everything is calculated from the rows on each
// request (no stored counters, NFR10), so the numbers always match the audit trail.
//
//   Prevented = food restaurants and marquees did NOT over-prepare after a forecast or
//               event-estimate warning (food-prevention/forecast.js; self-reported, an indicator).
//   Rescued   = servings handed over at an OTP-verified DELIVERY. A delivery reversed by
//               an upheld report becomes FAILED and stops counting.
//   Lost      = (a) lost in transit: picked up but never delivered (FAILED, or the
//               lost part of a partial delivery), plus
//               (b) expired unclaimed: food still unallocated when its listing expired.
//   Shortfall at pickup (reported separately, NOT in Lost): the donor handed over less
//               than offered, so that food may never have existed.
//   Waste ratio = (wasted - rescued restaurant food) / prepared, over records that
//               report waste: food that was rescued is not waste.
import { prisma } from '../../lib/prisma.js';
import { forbidden } from '../../lib/errors.js';
import { listingQuantities } from '../../lib/quantities.js';
import { pkToday } from '../../lib/time.js';
import { preventedServings, wasteRatio } from '../food-prevention/forecast.js';

const DAY_MS = 24 * 3_600_000;
const dayLabel = (d) => pkToday(new Date(d)).toISOString().slice(0, 10);
const weekLabel = (d) => {
  const day = pkToday(new Date(d));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10); // Monday
};

/** Which rows this user's view covers. Admin: everything. Donor / NGO: their own (scope=mine) or the whole platform. */
function scopeFor(user, scope) {
  if (scope !== 'mine' || user.role === 'ADMIN') return { kind: 'all' };
  if (user.role === 'DONOR') return { kind: 'donor', orgId: user.organisationId };
  if (user.role === 'NGO') return { kind: 'ngo', orgId: user.organisationId };
  throw forbidden('Only donors and NGOs have their own impact view');
}

const allocationScope = (s) =>
  s.kind === 'donor' ? { listing: { organisationId: s.orgId } } : s.kind === 'ngo' ? { request: { ngoId: s.orgId } } : {};

export async function impactSummary(user, { days = 30, scope = 'all', interval = 'day' } = {}) {
  const s = scopeFor(user, scope);
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
  const sinceDay = new Date(pkToday(now).getTime() - (days - 1) * DAY_MS);
  const bucket = interval === 'week' ? weekLabel : dayLabel;

  // ---- Rescued
  const deliveries = await prisma.handoverRecord.findMany({
    where: { type: 'DELIVERY', recordedAt: { gte: since }, task: { allocation: { status: 'DELIVERED', ...allocationScope(s) } } },
    select: {
      quantity: true,
      recordedAt: true,
      task: {
        select: {
          allocation: {
            select: {
              listing: { select: { organisation: { select: { id: true, name: true, type: true } } } },
              request: { select: { ngo: { select: { id: true, name: true, ngoType: true } } } },
            },
          },
        },
      },
    },
  });

  // ---- Lost in transit vs shortfall at pickup (from the handover records)
  const failed = await prisma.allocation.findMany({
    where: {
      updatedAt: { gte: since },
      OR: [{ status: 'FAILED' }, { status: { in: ['DELIVERED', 'PICKED_UP'] }, lostQuantity: { gt: 0 } }],
      ...allocationScope(s),
    },
    select: { status: true, quantity: true, lostQuantity: true, updatedAt: true, task: { select: { handovers: { select: { type: true, quantity: true } } } } },
  });
  const lostInTransitRows = [];
  let shortfallAtPickup = 0;
  for (const a of failed) {
    const handed = (type) => a.task?.handovers.find((h) => h.type === type)?.quantity;
    const picked = handed('PICKUP') ?? a.quantity;
    shortfallAtPickup += Math.max(0, a.quantity - picked);
    if (a.status === 'PICKED_UP') continue; // still on its way: nothing lost in transit yet
    const delivered = a.status === 'DELIVERED' ? (handed('DELIVERY') ?? a.quantity - a.lostQuantity) : 0;
    const transit = Math.max(0, picked - delivered);
    if (transit > 0) lostInTransitRows.push({ at: a.updatedAt, qty: transit });
  }

  // ---- Expired unclaimed (food never allocated before its listing expired)
  const expiredListings =
    s.kind === 'ngo'
      ? []
      : await prisma.surplusListing.findMany({
          where: { status: 'EXPIRED', updatedAt: { gte: since }, ...(s.kind === 'donor' ? { organisationId: s.orgId } : {}) },
          select: { id: true, confirmedQuantity: true, updatedAt: true },
        });
  const eq = await listingQuantities(prisma, expiredListings);
  const expiredRows = expiredListings.map((l) => ({ at: l.updatedAt, qty: eq.get(l.id).remaining })).filter((r) => r.qty > 0);

  // ---- Prevented and waste ratio (restaurant daily records)
  const records =
    s.kind === 'ngo'
      ? []
      : await prisma.dailyFoodRecord.findMany({
          where: { date: { gte: sinceDay }, ...(s.kind === 'donor' ? { foodItem: { organisationId: s.orgId } } : {}) },
          select: { date: true, planned: true, prepared: true, wasted: true, forecastShown: true, foodItem: { select: { organisation: { select: { type: true } } } } },
        });

  // ---- Listed (for the rescue rate)
  const listed =
    s.kind === 'ngo'
      ? null
      : (await prisma.surplusListing.aggregate({ _sum: { confirmedQuantity: true }, where: { createdAt: { gte: since }, ...(s.kind === 'donor' ? { organisationId: s.orgId } : {}) } }))._sum
          .confirmedQuantity ?? 0;

  // ---- Totals
  const sum = (rows, f) => rows.reduce((t, r) => t + f(r), 0);
  const rescued = sum(deliveries, (d) => d.quantity);
  const lostInTransit = sum(lostInTransitRows, (r) => r.qty);
  const expiredUnclaimed = sum(expiredRows, (r) => r.qty);
  const prevented = sum(records, (r) => preventedServings(r));
  const preventedByMarquees = sum(records.filter((r) => r.foodItem.organisation.type === 'MARQUEE_CATERER'), (r) => preventedServings(r));
  // Waste ratio: only records that report waste (restaurants), minus food that was rescued
  const wasteRecords = records.filter((r) => r.wasted !== null && r.wasted !== undefined);
  const rescuedFromRestaurants = (rows) => sum(rows.filter((d) => d.task.allocation.listing.organisation.type === 'RESTAURANT'), (d) => d.quantity);
  const netWasteRatio = (recs, rescuedQty) => wasteRatio(Math.max(0, sum(recs, (r) => r.wasted) - rescuedQty), sum(recs, (r) => r.prepared ?? 0));

  // ---- Trend (one bucket per day or week, oldest first, no gaps)
  const trend = new Map();
  const start = interval === 'week' ? weekLabel(since) : dayLabel(since);
  for (let t = new Date(`${start}T00:00:00Z`); t <= pkToday(now); t = new Date(t.getTime() + (interval === 'week' ? 7 : 1) * DAY_MS)) {
    trend.set(t.toISOString().slice(0, 10), { period: t.toISOString().slice(0, 10), prevented: 0, rescued: 0, lost: 0, prepared: 0, wasted: 0, rescuedRestaurant: 0 });
  }
  const addTo = (key, field, qty) => {
    const row = trend.get(key);
    if (row) row[field] += qty;
  };
  for (const d of deliveries) {
    addTo(bucket(d.recordedAt), 'rescued', d.quantity);
    if (d.task.allocation.listing.organisation.type === 'RESTAURANT') addTo(bucket(d.recordedAt), 'rescuedRestaurant', d.quantity);
  }
  for (const r of [...lostInTransitRows, ...expiredRows]) addTo(bucket(r.at), 'lost', r.qty);
  for (const r of records) {
    const key = interval === 'week' ? weekLabel(r.date) : new Date(r.date).toISOString().slice(0, 10);
    addTo(key, 'prevented', preventedServings(r));
    if (r.wasted !== null && r.wasted !== undefined) {
      addTo(key, 'prepared', r.prepared ?? 0);
      addTo(key, 'wasted', r.wasted);
    }
  }

  // ---- Breakdowns
  const group = (keyOf, nameOf) => {
    const m = new Map();
    for (const d of deliveries) {
      const k = keyOf(d);
      const row = m.get(k) || { ...nameOf(d), servings: 0 };
      row.servings += d.quantity;
      m.set(k, row);
    }
    return [...m.values()].sort((a, b) => b.servings - a.servings);
  };
  const alloc = (d) => d.task.allocation;

  return {
    scope: s.kind,
    days,
    from: since.toISOString(),
    to: now.toISOString(),
    totals: {
      prevented,
      preventedBreakdown: { restaurants: prevented - preventedByMarquees, marquees: preventedByMarquees },
      rescued,
      lost: lostInTransit + expiredUnclaimed,
      lostBreakdown: { lostInTransit, expiredUnclaimed },
      shortfallAtPickup,
      listed,
      rescueRate: listed ? Math.round((rescued / listed) * 1000) / 1000 : null,
      deliveries: deliveries.length,
      wasteRatio: netWasteRatio(wasteRecords, rescuedFromRestaurants(deliveries)),
    },
    trend: [...trend.values()].map(({ prepared, wasted, rescuedRestaurant, ...row }) => ({
      ...row,
      wasteRatio: wasteRatio(Math.max(0, wasted - rescuedRestaurant), prepared),
    })),
    topDonors: s.kind === 'ngo' ? [] : group((d) => alloc(d).listing.organisation.id, (d) => ({ donor: alloc(d).listing.organisation.name, type: alloc(d).listing.organisation.type })).slice(0, 10),
    byNgoType: group((d) => alloc(d).request.ngo.ngoType || 'OTHER', (d) => ({ ngoType: alloc(d).request.ngo.ngoType || 'OTHER' })),
    notes: [
      'Prevented is self-reported by restaurants and marquees and shown as an indicator.',
      'Shortfall at pickup (donor handed over less than offered) is shown separately, not as Lost.',
      'Rescued counts only OTP-verified deliveries.',
    ],
  };
}

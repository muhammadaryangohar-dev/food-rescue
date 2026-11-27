// Expire-on-read sweep (proposal §10 "Core algorithms"), plus a light timer.
//
//   1. On read requests, maybeSweep() runs a CHEAP check (a few indexed "is there
//      at least one overdue row?" queries), at most once every
//      SWEEP_MIN_INTERVAL_SECONDS. The server also calls maybeSweep() once a minute
//      (startSweepTimer), so expiry notices and near-expiry alerts go out on time even
//      when nobody is using the app. Correctness never depends on the timer: see 3.
//   2. Only if something is overdue does it take the allocation lock and run
//      sweepLocked(), which expires listings, unanswered offers, uncollected
//      accepted food, stuck volunteer claims, late deliveries and past-deadline
//      requests.
//   3. sweepLocked() is ALSO called at the start of every allocation write
//      (accept, reject, claim, ...), so an expired offer can never block food or be
//      accepted late, even if nobody has read anything recently.
// Released food is re-offered by the next matching run.
//
// Near-expiry alert: an open listing with less than NEAR_EXPIRY_HOURS left before
// its safe-until time triggers ONE urgent notification to verified NGOs within
// NEAR_EXPIRY_RADIUS_KM (if food is still unallocated) and to approved volunteers in
// that area (if a pickup is still waiting for a volunteer).
import { prisma } from '../../lib/prisma.js';
import { withAllocationLock } from '../../lib/lock.js';
import { recordTransition, ENTITY } from '../../lib/history.js';
import { notifyUsers, orgUserIds, listingDonorUserIds } from '../../lib/notify.js';
import { getNumber } from '../../lib/config.js';
import { RELEASABLE, listingQuantity } from '../../lib/quantities.js';
import { haversineKm } from '../../lib/haversine.js';
import { findArea } from '../../lib/areas.js';
import { pkTimeLabel } from '../../lib/time.js';
import { releaseAllocationLocked } from './allocation.service.js';
import { triggerMatching } from '../matching/matching.trigger.js';

const SYSTEM = null; // actorUserId for automatic transitions

/**
 * Cheap check: is anything overdue right now? ONE round-trip to the database
 * (six EXISTS sub-queries on indexed status/deadline columns), because on a remote
 * database every round-trip costs ~0.3 s.
 * Timestamps are stored as UTC without a time zone, so `now` is passed as a UTC
 * ISO string cast to ::timestamp (independent of the server's time zone).
 */
export async function hasOverdueRows(db = prisma, now = new Date()) {
  const t = now.toISOString();
  const soon = new Date(now.getTime() + (await getNumber('NEAR_EXPIRY_HOURS', db)) * 3_600_000).toISOString();
  const [row] = await db.$queryRaw`
    SELECT (
      EXISTS (SELECT 1 FROM allocations WHERE status = 'PROPOSED' AND response_deadline < ${t}::timestamp)
      OR EXISTS (SELECT 1 FROM allocations WHERE status = 'ACCEPTED' AND pickup_deadline < ${t}::timestamp)
      OR EXISTS (SELECT 1 FROM rescue_tasks WHERE status = 'CLAIMED' AND collector_type = 'VOLUNTEER' AND claim_deadline < ${t}::timestamp)
      OR EXISTS (SELECT 1 FROM allocations a JOIN surplus_listings l ON l.id = a.listing_id WHERE a.status = 'PICKED_UP' AND l.safe_until < ${t}::timestamp)
      OR EXISTS (SELECT 1 FROM surplus_listings WHERE status = 'OPEN' AND collection_deadline < ${t}::timestamp)
      OR EXISTS (SELECT 1 FROM ngo_requests WHERE status = 'OPEN' AND required_by < ${t}::timestamp)
      OR EXISTS (SELECT 1 FROM surplus_listings WHERE status = 'OPEN' AND near_expiry_alerted_at IS NULL AND safe_until < ${soon}::timestamp)
    ) AS overdue`;
  return row.overdue === true;
}

async function addNoShow(tx, volunteerId) {
  if (!volunteerId) return;
  await tx.volunteerProfile.update({ where: { id: volunteerId }, data: { noShowCount: { increment: 1 } } });
}

/** Volunteers who should hear about an urgent pickup in this listing's area. */
async function nearbyVolunteerUserIds(tx, listing, radiusKm) {
  const limit = await getNumber('VOLUNTEER_NO_SHOW_LIMIT', tx);
  const volunteers = await tx.volunteerProfile.findMany({
    where: { approvalStatus: 'VERIFIED', noShowCount: { lt: limit }, user: { active: true } },
    select: { userId: true, serviceArea: true },
  });
  return volunteers
    .filter((v) => {
      if (!v.serviceArea) return true; // works anywhere
      const area = findArea(v.serviceArea);
      if (!area) return v.serviceArea.toLowerCase() === listing.area.toLowerCase();
      const km = haversineKm(area.latitude, area.longitude, listing.latitude, listing.longitude);
      return km === null ? area.name === listing.area : km <= radiusKm;
    })
    .map((v) => v.userId);
}

/** Verified NGOs (active staff) within the near-expiry radius of the listing. */
async function nearbyNgoUserIds(tx, listing, radiusKm) {
  const ngos = await tx.organisation.findMany({
    where: { type: 'NGO', verificationStatus: 'VERIFIED', latitude: { not: null }, longitude: { not: null } },
    select: { id: true, latitude: true, longitude: true, users: { where: { active: true }, select: { id: true } } },
  });
  return ngos
    .filter((n) => {
      const km = haversineKm(listing.latitude, listing.longitude, n.latitude, n.longitude);
      return km !== null && km <= radiusKm;
    })
    .flatMap((n) => n.users.map((u) => u.id));
}

/** Step 7: one urgent alert per listing that is close to its safe-until time. */
async function alertNearExpiry(tx, now) {
  const hours = await getNumber('NEAR_EXPIRY_HOURS', tx);
  const radiusKm = await getNumber('NEAR_EXPIRY_RADIUS_KM', tx);
  const listings = await tx.surplusListing.findMany({
    where: { status: 'OPEN', nearExpiryAlertedAt: null, safeUntil: { lt: new Date(now.getTime() + hours * 3_600_000) } },
    include: { category: true, organisation: { select: { name: true } } },
  });
  let alerts = 0;
  for (const l of listings) {
    const q = await listingQuantity(tx, l);
    const what = `${l.category.name.toLowerCase()} at ${l.organisation.name}, ${l.area}`;
    const by = pkTimeLabel(l.collectionDeadline);
    if (q.remaining > 0) {
      await notifyUsers(tx, await nearbyNgoUserIds(tx, l, radiusKm), {
        type: 'NEAR_EXPIRY',
        message: `Urgent: ${q.remaining} servings of ${what} are still available and must be collected by ${by}.`,
        link: `/listings/${l.id}`,
      });
    }
    const waiting = await tx.rescueTask.count({ where: { status: 'OPEN', collectorType: 'VOLUNTEER', allocation: { listingId: l.id, status: 'ACCEPTED' } } });
    if (waiting > 0) {
      await notifyUsers(tx, await nearbyVolunteerUserIds(tx, l, radiusKm), {
        type: 'URGENT_PICKUP',
        message: `Urgent pickup: ${what} needs a volunteer now (collect by ${by}).`,
        link: '/volunteer/tasks',
      });
    }
    await tx.surplusListing.update({ where: { id: l.id }, data: { nearExpiryAlertedAt: now } });
    alerts++;
  }
  return alerts;
}

/** The real sweep. Caller MUST hold the allocation lock. Returns a summary. */
export async function sweepLocked(tx, now = new Date()) {
  const summary = { expiredOffers: 0, expiredAccepted: 0, releasedClaims: 0, failedDeliveries: 0, expiredListings: 0, expiredRequests: 0, nearExpiryAlerts: 0 };
  // Fast path: one query, and most of the time nothing is overdue
  if (!(await hasOverdueRows(tx, now))) return { ...summary, foodReleased: false, total: 0 };

  // 1. Offers the NGO never answered
  const unanswered = await tx.allocation.findMany({ where: { status: 'PROPOSED', responseDeadline: { lt: now } } });
  for (const a of unanswered) {
    await releaseAllocationLocked(tx, a, { to: 'EXPIRED', reason: 'NGO did not respond before the response deadline' });
    summary.expiredOffers++;
  }

  // 2. Accepted food nobody collected in time
  const uncollected = await tx.allocation.findMany({ where: { status: 'ACCEPTED', pickupDeadline: { lt: now } }, include: { task: true } });
  for (const a of uncollected) {
    if (a.task?.collectorType === 'VOLUNTEER' && a.task.status === 'CLAIMED') await addNoShow(tx, a.task.volunteerId);
    await releaseAllocationLocked(tx, a, { to: 'EXPIRED', reason: 'Food was not collected before the pickup deadline' });
    summary.expiredAccepted++;
  }

  // 3. Volunteer claimed a task but never picked up: release the claim, task goes back to OPEN
  const stuck = await tx.rescueTask.findMany({
    where: { status: 'CLAIMED', collectorType: 'VOLUNTEER', claimDeadline: { lt: now } },
    include: { volunteer: true, allocation: { include: { request: true } } },
  });
  for (const t of stuck) {
    await tx.rescueTask.update({ where: { id: t.id }, data: { status: 'OPEN', volunteerId: null, claimDeadline: null } });
    await addNoShow(tx, t.volunteerId);
    await recordTransition(tx, { entity: ENTITY.TASK, entityId: t.id, from: 'CLAIMED', to: 'OPEN', reason: 'Volunteer did not pick up in time; claim released', actorUserId: SYSTEM });
    await notifyUsers(tx, [t.volunteer?.userId], { type: 'CLAIM_RELEASED', message: `Your claim on task #${t.id} was released because the food was not picked up in time.`, link: `/volunteer/tasks/${t.id}` });
    await notifyUsers(tx, await orgUserIds(tx, t.allocation.request.ngoId), { type: 'CLAIM_RELEASED', message: `The volunteer for task #${t.id} did not show up. The task is open again.`, link: `/ngo/tasks/${t.id}` });
    summary.releasedClaims++;
  }

  // 4. Picked up but not delivered before the food stopped being safe: FAILED, all lost
  const late = await tx.allocation.findMany({ where: { status: 'PICKED_UP', listing: { safeUntil: { lt: now } } }, include: { task: true, listing: true, request: true } });
  for (const a of late) {
    await tx.allocation.update({ where: { id: a.id }, data: { status: 'FAILED', lostQuantity: a.quantity, decisionReason: 'Not delivered before safe-until time' } });
    await recordTransition(tx, { entity: ENTITY.ALLOCATION, entityId: a.id, from: 'PICKED_UP', to: 'FAILED', reason: 'Late delivery: food passed its safe-until time', actorUserId: SYSTEM });
    if (a.task) {
      await tx.rescueTask.update({ where: { id: a.task.id }, data: { status: 'CANCELLED' } });
      await recordTransition(tx, { entity: ENTITY.TASK, entityId: a.task.id, from: a.task.status, to: 'CANCELLED', reason: 'Late delivery', actorUserId: SYSTEM });
    }
    await tx.nGORequest.updateMany({ where: { id: a.requestId, status: 'OPEN' }, data: { reallocationPending: true } });
    await notifyUsers(tx, [...(await orgUserIds(tx, a.request.ngoId)), ...(await listingDonorUserIds(tx, a.listing))], {
      type: 'DELIVERY_FAILED',
      message: `Allocation #${a.id} failed: the food was not delivered before it stopped being safe.`,
      link: `/allocations/${a.id}`,
    });
    summary.failedDeliveries++;
  }

  // 5. Listings past their collection deadline
  const listings = await tx.surplusListing.findMany({ where: { status: 'OPEN', collectionDeadline: { lt: now } } });
  for (const l of listings) {
    const pending = await tx.allocation.findMany({ where: { listingId: l.id, status: { in: RELEASABLE } } });
    for (const a of pending) await releaseAllocationLocked(tx, a, { to: 'EXPIRED', reason: 'Listing passed its collection deadline' });
    await tx.surplusListing.update({ where: { id: l.id }, data: { status: 'EXPIRED' } });
    await recordTransition(tx, { entity: ENTITY.LISTING, entityId: l.id, from: 'OPEN', to: 'EXPIRED', reason: 'Collection deadline passed', actorUserId: SYSTEM });
    summary.expiredListings++;
  }

  // 6. Requests past their required-by time (offers still waiting are withdrawn;
  //    already accepted food keeps going so it is not wasted)
  const requests = await tx.nGORequest.findMany({ where: { status: 'OPEN', requiredBy: { lt: now } } });
  for (const r of requests) {
    const proposed = await tx.allocation.findMany({ where: { requestId: r.id, status: 'PROPOSED' } });
    for (const a of proposed) await releaseAllocationLocked(tx, a, { to: 'EXPIRED', reason: 'Request passed its required-by time', flagRequest: false });
    await tx.nGORequest.update({ where: { id: r.id }, data: { status: 'EXPIRED', reallocationPending: false } });
    await recordTransition(tx, { entity: ENTITY.REQUEST, entityId: r.id, from: 'OPEN', to: 'EXPIRED', reason: 'Required-by time passed', actorUserId: SYSTEM });
    await notifyUsers(tx, await orgUserIds(tx, r.ngoId), { type: 'REQUEST_EXPIRED', message: `Request #${r.id} expired (required-by time passed).`, link: `/ngo/requests/${r.id}` });
    summary.expiredRequests++;
  }

  // 7. Near-expiry alerts (after step 5, so only listings that are still open)
  summary.nearExpiryAlerts = await alertNearExpiry(tx, now);

  // Near-expiry food is also a reason to run matching again: it should go first
  summary.foodReleased = summary.expiredOffers + summary.expiredAccepted + summary.failedDeliveries + summary.nearExpiryAlerts > 0;
  summary.total = Object.entries(summary).filter(([k]) => k !== 'foodReleased').reduce((s, [, v]) => s + v, 0);
  return summary;
}

/** Full sweep with its own lock (admin "run sweep" button, tests). */
export async function runSweep(now = new Date()) {
  const summary = await withAllocationLock((tx) => sweepLocked(tx, now));
  if (summary.foodReleased) triggerMatching('sweep-released-food');
  return summary;
}

// ---------------------------------------------------------------- expire-on-read

let lastCheck = 0;
let inFlight = null;

/** Throttled cheap check, then sweep only if needed. Safe to call on every read. */
export async function maybeSweep() {
  const interval = (await getNumber('SWEEP_MIN_INTERVAL_SECONDS')) * 1000;
  if (Date.now() - lastCheck < interval) return null;
  if (inFlight) return inFlight;
  lastCheck = Date.now();
  inFlight = (async () => {
    try {
      if (!(await hasOverdueRows())) return null;
      return await runSweep();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Express middleware: start the expire-on-read check on GET requests. Never fails the request.
 * The page does NOT wait for the sweep (on Neon a sweep under the lock can take seconds).
 * Correctness does not depend on it: every write (accept, claim, pickup, ...) runs
 * sweepLocked() first, so an expired offer can never be acted on. Tests wait for it so
 * their results are predictable.
 */
export async function sweepOnRead(req, _res, next) {
  if (req.method === 'GET') {
    const run = maybeSweep().catch((err) => console.error('[sweep] failed:', err.message));
    if (process.env.NODE_ENV === 'test') await run;
  }
  next();
}

export function resetSweepThrottle() {
  lastCheck = 0;
}

/**
 * Light background timer (started by server.js, not by tests): runs the same cheap
 * check every `seconds`, so notices go out even when the app is idle. unref() keeps
 * it from holding the process open.
 */
export function startSweepTimer(seconds = 60) {
  const timer = setInterval(() => {
    maybeSweep().catch((err) => console.error('[sweep timer] failed:', err.message));
  }, seconds * 1000);
  timer.unref();
  return timer;
}

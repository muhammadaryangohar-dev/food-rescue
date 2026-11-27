// NGO requests (part of M5; the matching engine itself is Member 2's).
import { prisma, TX_OPTIONS } from '../../lib/prisma.js';
import { withAllocationLock } from '../../lib/lock.js';
import { recordTransition, ENTITY } from '../../lib/history.js';
import { requestQuantities, requestQuantity, REQUEST_COVERING, RELEASABLE } from '../../lib/quantities.js';
import { ownsRequest } from '../../lib/access.js';
import { badRequest, forbidden, notFound, conflict } from '../../lib/errors.js';
import { releaseAllocationLocked } from '../allocations/allocation.service.js';
import { sweepLocked } from '../allocations/sweep.service.js';
import { triggerMatching } from './matching.trigger.js';
import { pkDayRange, pkDateLabel } from '../../lib/time.js';

const REQUEST_INCLUDE = { category: true, ngo: { select: { id: true, name: true, area: true, dailyCapacity: true, serviceRadiusKm: true } } };

function checkRequest(data, ngo, now = new Date()) {
  if (data.requiredBy && data.requiredBy <= now) throw badRequest('Required-by time must be in the future');
  if (data.requestedQuantity && ngo.dailyCapacity && data.requestedQuantity > ngo.dailyCapacity) {
    throw badRequest(`Request cannot exceed your daily capacity of ${ngo.dailyCapacity} servings`);
  }
}

// Requests that still count against the day's capacity (cancelled and expired ones do not)
const COUNTS_FOR_CAPACITY = ['OPEN', 'FULFILLED'];

/**
 * Daily capacity is per DAY, not per request: all of an NGO's requests needed on the
 * same Pakistan calendar day must add up to no more than its daily capacity.
 */
async function checkDailyTotal(db, ngo, { requiredBy, requestedQuantity, excludeId = null }) {
  if (!ngo.dailyCapacity) return;
  const { start, end } = pkDayRange(requiredBy);
  const { _sum } = await db.nGORequest.aggregate({
    _sum: { requestedQuantity: true },
    where: { ngoId: ngo.id, status: { in: COUNTS_FOR_CAPACITY }, requiredBy: { gte: start, lt: end }, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  const already = _sum.requestedQuantity ?? 0;
  if (already + requestedQuantity > ngo.dailyCapacity) {
    const left = Math.max(0, ngo.dailyCapacity - already);
    throw badRequest(
      `You already requested ${already} servings for ${pkDateLabel(requiredBy)}. Your daily capacity is ${ngo.dailyCapacity}, so you can request at most ${left} more for that day.`,
      { code: 'DAILY_CAPACITY', alreadyRequested: already, dailyCapacity: ngo.dailyCapacity, remaining: left },
    );
  }
}

// Per-NGO advisory lock (two-key form, separate from the global allocation lock) so two
// requests created at the same moment cannot both pass the daily-capacity check.
const REQUEST_LOCK_KEY = 336006;

export async function createRequest(user, data) {
  const category = await prisma.foodCategory.findUnique({ where: { id: data.categoryId } });
  if (!category) throw badRequest('Unknown food category');
  checkRequest(data, user.organisation);

  const request = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REQUEST_LOCK_KEY}::int, ${user.organisationId}::int)`;
    await checkDailyTotal(tx, user.organisation, data);
    const r = await tx.nGORequest.create({ data: { ...data, ngoId: user.organisationId, createdById: user.id }, include: REQUEST_INCLUDE });
    await recordTransition(tx, { entity: ENTITY.REQUEST, entityId: r.id, from: null, to: 'OPEN', reason: 'Request created', actorUserId: user.id });
    return r;
  }, TX_OPTIONS);
  triggerMatching('request-created');
  return { ...request, quantities: await requestQuantity(prisma, request) };
}

export async function listRequests(user, { status }) {
  const where = {};
  if (status) where.status = status;
  if (user.role === 'NGO') where.ngoId = user.organisationId;
  else if (user.role !== 'ADMIN') throw forbidden('Only NGOs and admins can view requests');
  const requests = await prisma.nGORequest.findMany({ where, include: REQUEST_INCLUDE, orderBy: [{ status: 'asc' }, { requiredBy: 'asc' }], take: 200 });
  const qty = await requestQuantities(prisma, requests);
  return requests.map((r) => ({ ...r, quantities: qty.get(r.id) }));
}

async function loadOwned(db, user, id) {
  const request = await db.nGORequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
  if (!request) throw notFound('Request');
  if (user.role !== 'ADMIN' && !ownsRequest(user, request)) throw forbidden('This is not your request');
  return request;
}

export async function getRequest(user, id) {
  const request = await loadOwned(prisma, user, id);
  const allocations = await prisma.allocation.findMany({
    where: { requestId: id },
    include: {
      listing: { select: { id: true, description: true, area: true, safeUntil: true, collectionDeadline: true, category: { select: { name: true } } } },
      task: { select: { id: true, status: true, collectorType: true } },
    },
    orderBy: { proposedAt: 'desc' },
  });
  return { ...request, quantities: await requestQuantity(prisma, request), allocations };
}

/**
 * Edit rules: while offers exist for this request, the category and required-by
 * time are locked, and the quantity can only go up (never below what is already
 * covered). Notes can always change.
 */
export async function updateRequest(user, id, data) {
  const result = await withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    const request = await loadOwned(tx, user, id);
    if (request.status !== 'OPEN') throw conflict(`Cannot edit a ${request.status.toLowerCase()} request`);
    checkRequest(data, request.ngo);
    if (data.requestedQuantity !== undefined || data.requiredBy !== undefined) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REQUEST_LOCK_KEY}::int, ${request.ngoId}::int)`;
      await checkDailyTotal(tx, request.ngo, {
        requiredBy: data.requiredBy ?? request.requiredBy,
        requestedQuantity: data.requestedQuantity ?? request.requestedQuantity,
        excludeId: id,
      });
    }

    const covering = await tx.allocation.count({ where: { requestId: id, status: { in: REQUEST_COVERING } } });
    if (covering > 0) {
      const locked = ['categoryId', 'requiredBy'].filter((f) => data[f] !== undefined);
      if (locked.length) throw conflict(`This request already has offers, so ${locked.join(', ')} cannot change`, { lockedFields: locked });
      if (data.requestedQuantity !== undefined) {
        const q = await requestQuantity(tx, request);
        if (data.requestedQuantity < q.covered) throw conflict(`${q.covered} servings are already offered or delivered; quantity cannot go below that`);
      }
    }
    const updated = await tx.nGORequest.update({ where: { id }, data, include: REQUEST_INCLUDE });
    return { ...updated, quantities: await requestQuantity(tx, updated) };
  });
  if (data.requestedQuantity) triggerMatching('request-updated');
  return result;
}

/** NGO cancels a request. Offers not yet picked up are cancelled and their food released. */
export async function cancelRequest(user, id, { reason } = {}) {
  const result = await withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    const request = await loadOwned(tx, user, id);
    if (request.status !== 'OPEN') throw conflict(`Request is already ${request.status.toLowerCase()}`);
    const onTheWay = await tx.allocation.count({ where: { requestId: id, status: 'PICKED_UP' } });
    if (onTheWay > 0) throw conflict('Some food for this request is already on its way. Wait for delivery or report an issue.');

    const why = reason ? `Request cancelled by NGO: ${reason}` : 'Request cancelled by NGO';
    const pending = await tx.allocation.findMany({ where: { requestId: id, status: { in: RELEASABLE } } });
    for (const a of pending) await releaseAllocationLocked(tx, a, { to: 'CANCELLED', reason: why, actorUserId: user.id, flagRequest: false });
    await tx.nGORequest.update({ where: { id }, data: { status: 'CANCELLED', reallocationPending: false } });
    await recordTransition(tx, { entity: ENTITY.REQUEST, entityId: id, from: 'OPEN', to: 'CANCELLED', reason: why, actorUserId: user.id });
    return { requestId: id, cancelledAllocations: pending.length };
  });
  if (result.cancelledAllocations) triggerMatching('request-cancelled');
  return result;
}

/**
 * "Why wasn't I matched?" (NFR7 explainability). Shows, for the most recent matching
 * run that considered this request, every listing it looked at: whether it was
 * eligible, the plain-language rejection reason from the stage-1 filters, and the
 * stage-2 score breakdown. The rows are written by the matching engine (Member 2)
 * into match_decisions. Donor identity and exact location stay hidden (only the area).
 */
export async function getMatchDecisions(user, id) {
  const request = await loadOwned(prisma, user, id);
  const latest = await prisma.matchDecision.findFirst({ where: { requestId: id }, orderBy: { createdAt: 'desc' }, select: { runId: true, createdAt: true } });
  if (!latest) {
    return { requestId: id, runId: null, runAt: null, decisions: [], message: 'No matching run has considered this request yet.' };
  }

  const rows = await prisma.matchDecision.findMany({
    where: { requestId: id, runId: latest.runId },
    include: { listing: { select: { id: true, description: true, area: true, safeUntil: true, collectionDeadline: true, category: { select: { name: true } } } } },
    orderBy: [{ eligible: 'desc' }, { score: 'desc' }],
  });
  const offered = await prisma.allocation.findMany({ where: { requestId: id, listingId: { in: rows.map((r) => r.listingId) } }, select: { listingId: true, status: true, quantity: true } });
  const offerByListing = new Map(offered.map((a) => [a.listingId, a]));

  const decisions = rows.map((d) => {
    const offer = offerByListing.get(d.listingId);
    let summary;
    if (!d.eligible) summary = `Not offered: ${d.rejectionReason || 'did not pass the feasibility checks'}.`;
    else if (offer) summary = `Offered ${offer.quantity} servings (score ${d.score?.toFixed(1)} / 100).`;
    else summary = `Eligible (score ${d.score?.toFixed(1)} / 100) but another pairing scored higher or the food ran out.`;
    return {
      listing: { id: d.listing.id, description: d.listing.description, category: d.listing.category.name, area: d.listing.area, safeUntil: d.listing.safeUntil, collectionDeadline: d.listing.collectionDeadline },
      eligible: d.eligible,
      rejectionReason: d.rejectionReason,
      score: d.score,
      scoreBreakdown: d.scoreBreakdown,
      offer: offer ? { status: offer.status, quantity: offer.quantity } : null,
      summary,
    };
  });

  return {
    requestId: id,
    runId: latest.runId,
    runAt: latest.createdAt,
    remainingNeed: (await requestQuantity(prisma, request)).remainingNeed,
    considered: decisions.length,
    eligible: decisions.filter((d) => d.eligible).length,
    decisions,
  };
}

/** Mark a request FULFILLED once delivered food covers it. Call inside the lock. */
export async function fulfilIfComplete(tx, requestId, actorUserId = null) {
  const request = await tx.nGORequest.findUnique({ where: { id: requestId } });
  if (!request || request.status !== 'OPEN') return;
  const q = await requestQuantity(tx, request);
  if (q.delivered >= request.requestedQuantity) {
    await tx.nGORequest.update({ where: { id: requestId }, data: { status: 'FULFILLED', reallocationPending: false } });
    await recordTransition(tx, { entity: ENTITY.REQUEST, entityId: requestId, from: 'OPEN', to: 'FULFILLED', reason: 'All requested food delivered', actorUserId });
  }
}

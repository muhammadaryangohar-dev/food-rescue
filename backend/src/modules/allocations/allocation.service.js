// M6 Allocations — the transaction-safe heart of the Perishability-Aware Allocation Engine.
//
// Golden rule: every function that changes allocation state runs inside
// withAllocationLock() (one PostgreSQL advisory lock), re-reads rows, re-checks the
// rules and recomputes remaining quantities from allocation rows before writing.
// See src/lib/lock.js for why one global lock was chosen.
import { withAllocationLock } from '../../lib/lock.js';
import { recordTransition, ENTITY } from '../../lib/history.js';
import { notifyUsers, orgUserIds, listingDonorUserIds } from '../../lib/notify.js';
import { listingQuantity, requestQuantity, RELEASABLE } from '../../lib/quantities.js';
import { getNumber } from '../../lib/config.js';
import { conflict, notFound, forbidden, gone, badRequest } from '../../lib/errors.js';
import { ownsRequest, orgCanAct } from '../../lib/access.js';
import { newNonce, deriveOtp, hashOtp } from '../../lib/otp.js';
import { sweepLocked } from './sweep.service.js';
import { triggerMatching } from '../matching/matching.trigger.js';
import { pkTimeLabel } from '../../lib/time.js';

const minutesFromNow = (m) => new Date(Date.now() + m * 60_000);
const earliest = (...dates) => new Date(Math.min(...dates.filter(Boolean).map((d) => new Date(d).getTime())));

const LISTING_WITH_DONOR = { organisation: true, event: true, category: true };

/** The donor business is verified and its food licence has not expired. */
function donorVerified(listing) {
  return orgCanAct(listing.organisation);
}

// An NGO that rejected an offer, or let it expire, is never offered the same food again
// (stops the reject -> re-offer loop). Cancelled offers are not the NGO's choice, so they
// do not count.
export const DECLINED = ['REJECTED', 'EXPIRED'];

// ------------------------------------------------------------------ create

/**
 * Create one PROPOSED allocation. MUST be called with a transaction that already
 * holds the allocation lock (use createAllocation() otherwise).
 * Used by the matching engine (Member 2) and by the admin manual-allocation tool.
 *
 * Re-checks: both sides open and not past deadlines, both sides verified, category
 * match, minimum size, and — most importantly — quantity <= remaining on the listing
 * AND <= remaining need on the request, both recomputed from allocation rows now.
 */
export async function createAllocationLocked(tx, { listingId, requestId, quantity, score = null, scoreBreakdown = null, explanation = null, actorUserId = null, now = new Date() }) {
  const listing = await tx.surplusListing.findUnique({ where: { id: listingId }, include: LISTING_WITH_DONOR });
  if (!listing) throw notFound('Listing');
  const request = await tx.nGORequest.findUnique({ where: { id: requestId }, include: { ngo: true, category: true } });
  if (!request) throw notFound('Request');

  if (listing.status !== 'OPEN') throw conflict(`Listing is ${listing.status.toLowerCase()}`);
  if (listing.collectionDeadline <= now || listing.safeUntil <= now) throw conflict('Listing is past its collection deadline');
  if (request.status !== 'OPEN') throw conflict(`Request is ${request.status.toLowerCase()}`);
  if (request.requiredBy <= now) throw conflict('Request is past its required-by time');
  if (!donorVerified(listing)) throw conflict('Donor is not verified or its food licence has expired');
  if (request.ngo.verificationStatus !== 'VERIFIED') throw conflict('NGO is not verified');
  if (listing.categoryId !== request.categoryId) throw conflict('Food category does not match the request');
  if (!Number.isInteger(quantity) || quantity <= 0) throw badRequest('Quantity must be a positive whole number');
  const declined = await tx.allocation.findFirst({ where: { listingId, requestId, status: { in: DECLINED } }, select: { status: true } });
  if (declined) {
    throw conflict(`This NGO already ${declined.status === 'REJECTED' ? 'rejected' : 'did not answer'} an offer of this food, so it will not be offered again`, { code: 'ALREADY_DECLINED' });
  }

  const lq = await listingQuantity(tx, listing);
  const rq = await requestQuantity(tx, request);
  if (quantity > lq.remaining) {
    throw conflict(`Only ${lq.remaining} servings left on this listing`, { code: 'OVER_ALLOCATION', remaining: lq.remaining });
  }
  if (quantity > rq.remainingNeed) {
    throw conflict(`Request only needs ${rq.remainingNeed} more servings`, { code: 'OVER_FILL', remainingNeed: rq.remainingNeed });
  }
  const minSize = await getNumber('MIN_ALLOCATION_SERVINGS', tx);
  // Allow a smaller final piece when it uses up the last of the listing or the need
  if (quantity < minSize && quantity !== lq.remaining && quantity !== rq.remainingNeed) {
    throw conflict(`Allocation must be at least ${minSize} servings`);
  }

  const responseMinutes = await getNumber('OFFER_RESPONSE_MINUTES', tx);
  const allocation = await tx.allocation.create({
    data: {
      listingId,
      requestId,
      quantity,
      score,
      scoreBreakdown,
      explanation,
      responseDeadline: earliest(minutesFromNow(responseMinutes), listing.collectionDeadline, request.requiredBy),
    },
  });

  if (rq.remainingNeed - quantity === 0 && request.reallocationPending) {
    await tx.nGORequest.update({ where: { id: requestId }, data: { reallocationPending: false } });
  }

  await recordTransition(tx, { entity: ENTITY.ALLOCATION, entityId: allocation.id, from: null, to: 'PROPOSED', reason: explanation || 'Offer created', actorUserId });
  await notifyUsers(tx, await orgUserIds(tx, request.ngoId), {
    type: 'OFFER_PROPOSED',
    message: `New offer: ${quantity} servings of ${listing.category.name} for your request #${request.id}. Please respond before it expires.`,
    link: `/ngo/offers/${allocation.id}`,
  });
  return allocation;
}

/** Locked wrapper around createAllocationLocked for single allocations. */
export async function createAllocation(params) {
  return withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    return createAllocationLocked(tx, params);
  });
}

// ------------------------------------------------------------------ release

/**
 * Move an un-collected allocation (PROPOSED or ACCEPTED) to REJECTED / EXPIRED /
 * CANCELLED. Its food is released automatically because derived quantities stop
 * counting it. Cancels the rescue task if one exists. Call inside the lock.
 */
export async function releaseAllocationLocked(tx, allocation, { to, reason, actorUserId = null, flagRequest = true, notify = true }) {
  if (!RELEASABLE.includes(allocation.status)) throw conflict(`Cannot ${to.toLowerCase()} an allocation that is ${allocation.status.toLowerCase()}`);

  await tx.allocation.update({
    where: { id: allocation.id },
    data: { status: to, decisionReason: reason, reallocationCount: { increment: 1 } },
  });
  await recordTransition(tx, { entity: ENTITY.ALLOCATION, entityId: allocation.id, from: allocation.status, to, reason, actorUserId });

  const task = await tx.rescueTask.findUnique({ where: { allocationId: allocation.id }, include: { volunteer: true } });
  if (task && !['DELIVERED', 'CANCELLED'].includes(task.status)) {
    await tx.rescueTask.update({ where: { id: task.id }, data: { status: 'CANCELLED' } });
    await recordTransition(tx, { entity: ENTITY.TASK, entityId: task.id, from: task.status, to: 'CANCELLED', reason, actorUserId });
    if (notify && task.volunteer) {
      await notifyUsers(tx, [task.volunteer.userId], { type: 'TASK_CANCELLED', message: `Rescue task #${task.id} was cancelled: ${reason}`, link: `/volunteer/tasks/${task.id}` });
    }
  }

  if (flagRequest) {
    await tx.nGORequest.updateMany({ where: { id: allocation.requestId, status: 'OPEN' }, data: { reallocationPending: true } });
  }

  if (notify) {
    const listing = await tx.surplusListing.findUnique({ where: { id: allocation.listingId } });
    const request = await tx.nGORequest.findUnique({ where: { id: allocation.requestId } });
    const msg = `Allocation #${allocation.id} (${allocation.quantity} servings) is now ${to.toLowerCase()}: ${reason}`;
    await notifyUsers(tx, [...(await orgUserIds(tx, request.ngoId)), ...(await listingDonorUserIds(tx, listing))], {
      type: `ALLOCATION_${to}`,
      message: msg,
      link: `/allocations/${allocation.id}`,
    });
  }
}

// ------------------------------------------------------------------ NGO actions

async function loadForNgo(tx, user, allocationId) {
  const allocation = await tx.allocation.findUnique({
    where: { id: allocationId },
    include: { request: { include: { ngo: true } }, listing: { include: LISTING_WITH_DONOR } },
  });
  if (!allocation) throw notFound('Allocation');
  if (user.role !== 'ADMIN' && !ownsRequest(user, allocation.request)) throw forbidden('This offer is not for your organisation');
  return allocation;
}

/**
 * NGO accepts a proposed offer. The sweep runs first inside the same lock, so an
 * offer that expired while the NGO was looking at it can never be accepted
 * ("offers that expire while being viewed", CP4).
 */
export async function acceptAllocation(user, allocationId, { selfCollect = false } = {}) {
  return withAllocationLock(async (tx) => {
    const now = new Date();
    await sweepLocked(tx, now);
    const allocation = await loadForNgo(tx, user, allocationId);

    if (allocation.status === 'EXPIRED') throw gone('This offer has expired and the food was released');
    if (allocation.status !== 'PROPOSED') throw conflict(`Offer is already ${allocation.status.toLowerCase()}`);
    const { listing, request } = allocation;
    // Re-check with fresh rows
    if (listing.status !== 'OPEN' || listing.collectionDeadline <= now || listing.safeUntil <= now) throw gone('The food is no longer available');
    if (request.status !== 'OPEN') throw conflict(`Your request is ${request.status.toLowerCase()}`);

    const pickupMinutes = await getNumber('PICKUP_WINDOW_MINUTES', tx);
    const pickupDeadline = earliest(minutesFromNow(pickupMinutes), listing.collectionDeadline);
    await tx.allocation.update({ where: { id: allocation.id }, data: { status: 'ACCEPTED', pickupDeadline, decisionReason: null } });
    await recordTransition(tx, { entity: ENTITY.ALLOCATION, entityId: allocation.id, from: 'PROPOSED', to: 'ACCEPTED', reason: selfCollect ? 'Accepted (NGO will self-collect)' : 'Accepted', actorUserId: user.id });

    // Create the rescue task with its two one-time codes
    const nonce = newNonce();
    const task = await tx.rescueTask.create({
      data: {
        allocationId: allocation.id,
        collectorType: selfCollect ? 'NGO' : 'VOLUNTEER',
        status: selfCollect ? 'CLAIMED' : 'OPEN',
        otpNonce: nonce,
        pickupOtpHash: hashOtp(deriveOtp(nonce, 'PICKUP')),
        deliveryOtpHash: hashOtp(deriveOtp(nonce, 'DELIVERY')),
        otpExpiresAt: listing.safeUntil,
        claimDeadline: selfCollect ? pickupDeadline : null,
      },
    });
    await recordTransition(tx, { entity: ENTITY.TASK, entityId: task.id, from: null, to: task.status, reason: selfCollect ? 'NGO self-collect' : 'Waiting for a volunteer', actorUserId: user.id });

    await notifyUsers(tx, await listingDonorUserIds(tx, listing), {
      type: 'OFFER_ACCEPTED',
      message: `${request.ngo?.name || 'An NGO'} accepted ${allocation.quantity} servings from listing #${listing.id}. ${selfCollect ? 'The NGO will collect it.' : 'A volunteer will collect it.'} Your pickup code is in the task screen.`,
      link: `/donor/listings/${listing.id}`,
    });
    if (!selfCollect) {
      const volunteers = await tx.volunteerProfile.findMany({
        where: {
          approvalStatus: 'VERIFIED',
          user: { active: true },
          OR: [{ serviceArea: null }, { serviceArea: { equals: listing.area, mode: 'insensitive' } }],
        },
        select: { userId: true },
      });
      // Near-expiry food: the notice is marked urgent (same rule as the sweep's alert)
      const urgent = listing.safeUntil - now < (await getNumber('NEAR_EXPIRY_HOURS', tx)) * 3_600_000;
      await notifyUsers(tx, volunteers.map((v) => v.userId), {
        type: urgent ? 'URGENT_PICKUP' : 'TASK_AVAILABLE',
        message: `${urgent ? 'Urgent pickup' : 'New rescue task'} near ${listing.area}: ${allocation.quantity} servings, pick up before ${pkTimeLabel(pickupDeadline)}.`,
        link: `/volunteer/tasks/${task.id}`,
      });
    }

    return tx.allocation.findUnique({ where: { id: allocation.id }, include: { task: true } });
  });
}

/** NGO rejects a proposed offer; the food is released and re-offered by the next matching run. */
export async function rejectAllocation(user, allocationId, { reason }) {
  const result = await withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    const allocation = await loadForNgo(tx, user, allocationId);
    if (allocation.status === 'EXPIRED') throw gone('This offer has already expired');
    if (allocation.status !== 'PROPOSED') throw conflict(`Offer is already ${allocation.status.toLowerCase()}`);
    await releaseAllocationLocked(tx, allocation, { to: 'REJECTED', reason: reason || 'Rejected by NGO', actorUserId: user.id });
    return tx.allocation.findUnique({ where: { id: allocation.id } });
  });
  triggerMatching('offer-rejected');
  return result;
}

/** NGO (own offer) or admin cancels an offer before pickup. */
export async function cancelAllocation(user, allocationId, { reason }) {
  const result = await withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    const allocation = await loadForNgo(tx, user, allocationId);
    if (allocation.status === 'PICKED_UP') throw conflict('Food is already picked up; report an issue instead');
    await releaseAllocationLocked(tx, allocation, { to: 'CANCELLED', reason: reason || `Cancelled by ${user.role.toLowerCase()}`, actorUserId: user.id });
    return tx.allocation.findUnique({ where: { id: allocation.id } });
  });
  triggerMatching('offer-cancelled');
  return result;
}

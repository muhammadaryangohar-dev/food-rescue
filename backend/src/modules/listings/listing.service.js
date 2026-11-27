// M4 Listings: surplus listings, safe-until and deadlines, safety confirmation,
// withdrawal and edit rules. Remaining quantity is derived here (lib/quantities.js).
import { prisma, TX_OPTIONS } from '../../lib/prisma.js';
import { withAllocationLock } from '../../lib/lock.js';
import { recordTransition, ENTITY } from '../../lib/history.js';
import { listingQuantities, listingQuantity, LISTING_HOLDING, RELEASABLE } from '../../lib/quantities.js';
import { canSeeExactListing, maskLocation } from '../../lib/privacy.js';
import { ownsListing } from '../../lib/access.js';
import { badRequest, forbidden, notFound, conflict } from '../../lib/errors.js';
import { releaseAllocationLocked } from '../allocations/allocation.service.js';
import { sweepLocked } from '../allocations/sweep.service.js';
import { triggerMatching } from '../matching/matching.trigger.js';
import { LOCKED_FIELDS } from './listing.schemas.js';
import { withAreaFallback } from '../../lib/areas.js';
import { getCachedNumber } from '../../lib/config.js';

export const LISTING_INCLUDE = {
  organisation: { select: { id: true, name: true, type: true, verificationStatus: true } },
  event: { select: { id: true, name: true, organisationId: true } },
  category: true,
};

const HOUR = 3_600_000;

// ---------------------------------------------------------------- views

function donorName(listing) {
  const org = listing.organisation?.name ?? 'Donor';
  return listing.event ? `${org} (event: ${listing.event.name})` : org;
}

/** Urgency flag shown on listings and tasks (near-expiry alert, NEAR_EXPIRY_HOURS). */
export function urgency(safeUntil, now = new Date()) {
  const hoursLeft = Math.round(((new Date(safeUntil) - now) / 3_600_000) * 10) / 10;
  return { hoursLeft, nearExpiry: hoursLeft > 0 && hoursLeft < getCachedNumber('NEAR_EXPIRY_HOURS') };
}

export function listingView(listing, qty, exact) {
  return maskLocation({ ...listing, donorName: donorName(listing), quantities: qty, ...urgency(listing.safeUntil) }, exact);
}

// ---------------------------------------------------------------- rules

/** Date rules shared by create and edit. */
function checkDates({ preparedAt, safeUntil, collectionDeadline }, category, now = new Date()) {
  if (preparedAt > new Date(now.getTime() + 5 * 60_000)) throw badRequest('Prepared time cannot be in the future');
  if (safeUntil <= now) throw badRequest('Safe-until time must be in the future');
  if (collectionDeadline <= now) throw badRequest('Collection deadline must be in the future');
  if (collectionDeadline > safeUntil) throw badRequest('Collection deadline cannot be later than the safe-until time');
  if (preparedAt >= safeUntil) throw badRequest('Safe-until must be after the prepared time');
  const maxSafe = new Date(preparedAt.getTime() + category.defaultSafeHours * HOUR);
  if (safeUntil > maxSafe) {
    throw badRequest(`${category.name} is only safe for ${category.defaultSafeHours} hours after preparation (until ${maxSafe.toISOString()})`);
  }
}

// ---------------------------------------------------------------- create

/**
 * Create a listing inside an existing transaction. Exported so the Events module
 * (Member 2) can create a listing when leftovers are confirmed:
 *   createListingTx(tx, user, data, { sourceType: 'EVENT', eventId })
 * The listing always belongs to a donor business: for an event it is the event's organiser.
 */
export async function createListingTx(tx, user, data, { sourceType, organisationId = null, eventId = null }) {
  const category = await tx.foodCategory.findUnique({ where: { id: data.categoryId } });
  if (!category) throw badRequest('Unknown food category');
  checkDates(data, category);
  if (eventId) {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { organisationId: true } });
    if (!event) throw badRequest('Unknown event');
    if (organisationId && organisationId !== event.organisationId) throw badRequest('The event belongs to another organisation');
    organisationId = event.organisationId;
  }
  if (!organisationId) throw badRequest('A listing must belong to a donor business');

  const listing = await tx.surplusListing.create({
    data: {
      sourceType,
      organisationId,
      eventId,
      createdById: user.id,
      categoryId: data.categoryId,
      description: data.description,
      confirmedQuantity: data.confirmedQuantity,
      preparedAt: data.preparedAt,
      safeUntil: data.safeUntil,
      collectionDeadline: data.collectionDeadline,
      address: data.address,
      area: data.area,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      handlingNotes: data.handlingNotes,
      dietaryInfo: data.dietaryInfo,
      safetyConfirmed: true,
    },
    include: LISTING_INCLUDE,
  });
  await recordTransition(tx, { entity: ENTITY.LISTING, entityId: listing.id, from: null, to: 'OPEN', reason: 'Listing created', actorUserId: user.id });
  return listing;
}

export async function createListing(user, data) {
  const listing = await prisma.$transaction(async (tx) => {
    // Pick the donor source and default the location from the donor's profile
    let source;
    let defaults;
    if (data.eventId) {
      const event = await tx.event.findUnique({ where: { id: data.eventId } });
      if (!event || event.organisationId !== user.organisationId) throw forbidden('That event is not yours');
      source = { sourceType: 'EVENT', organisationId: user.organisationId, eventId: event.id };
      defaults = user.organisation;
    } else {
      if (user.donorType !== 'RESTAURANT') throw badRequest('Marquees and caterers list leftovers from one of their events (eventId)');
      source = { sourceType: 'RESTAURANT', organisationId: user.organisationId };
      defaults = user.organisation;
    }
    // Location: a map point if given; otherwise a newly chosen area's centre (manual
    // area fallback); otherwise the donor's profile location.
    const point =
      data.area !== undefined && data.latitude == null
        ? { area: data.area, latitude: null, longitude: null }
        : { area: data.area ?? defaults.area, latitude: data.latitude ?? defaults.latitude, longitude: data.longitude ?? defaults.longitude };
    const withLocation = { ...data, ...withAreaFallback(point), address: data.address ?? defaults.address };
    return createListingTx(tx, user, withLocation, source);
  }, TX_OPTIONS);
  triggerMatching('listing-created');
  return listingView(listing, await listingQuantity(prisma, listing), true);
}

// ---------------------------------------------------------------- read

function ownedListingsWhere(user) {
  return { organisationId: user.organisationId ?? -1 };
}

export async function listListings(user, query) {
  const where = {};
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.area) where.area = { equals: query.area, mode: 'insensitive' };

  if (user.role === 'DONOR') {
    Object.assign(where, ownedListingsWhere(user));
    if (query.status) where.status = query.status;
  } else if (user.role === 'NGO' || user.role === 'ADMIN') {
    where.status = query.status || 'OPEN';
  } else {
    throw forbidden('Volunteers see food through rescue tasks');
  }

  const listings = await prisma.surplusListing.findMany({ where, include: LISTING_INCLUDE, orderBy: [{ status: 'asc' }, { safeUntil: 'asc' }], take: 200 });
  const qty = await listingQuantities(prisma, listings);
  const views = [];
  for (const l of listings) {
    const q = qty.get(l.id);
    // NGOs browsing open food only see listings that still have food left
    if (user.role === 'NGO' && l.status === 'OPEN' && q.remaining === 0) continue;
    views.push(listingView(l, q, await canSeeExactListing(prisma, user, l)));
  }
  return views;
}

export async function getListing(user, id) {
  const listing = await prisma.surplusListing.findUnique({ where: { id }, include: LISTING_INCLUDE });
  if (!listing) throw notFound('Listing');
  if (user.role === 'VOLUNTEER') {
    const ok = await canSeeExactListing(prisma, user, listing);
    if (!ok) throw forbidden('You can only see listings for tasks you hold');
  }
  const owner = user.role === 'ADMIN' || ownsListing(user, listing);
  const exact = await canSeeExactListing(prisma, user, listing);

  // Owners/admins see every allocation; an NGO sees only its own
  const allocWhere = { listingId: id };
  if (!owner) {
    if (user.role === 'NGO') allocWhere.request = { ngoId: user.organisationId };
    else allocWhere.id = -1;
  }
  const allocations = await prisma.allocation.findMany({
    where: allocWhere,
    include: { request: { select: { id: true, ngo: { select: { id: true, name: true } } } }, task: { select: { id: true, status: true, collectorType: true } } },
    orderBy: { proposedAt: 'desc' },
  });
  return { ...listingView(listing, await listingQuantity(prisma, listing), exact), allocations };
}

// ---------------------------------------------------------------- edit / withdraw

async function loadOwned(tx, user, id) {
  const listing = await tx.surplusListing.findUnique({ where: { id }, include: LISTING_INCLUDE });
  if (!listing) throw notFound('Listing');
  if (user.role !== 'ADMIN' && !ownsListing(user, listing)) throw forbidden('This is not your listing');
  return listing;
}

/**
 * Edit rules (FR5): "A listing cannot be changed in a way that conflicts with its
 * existing allocations". Once any allocation holds food from it, quantity,
 * deadlines, category and location are locked; only description, handling notes
 * and dietary info can change. To change the rest: withdraw and create a new one.
 */
export async function updateListing(user, id, data) {
  return withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    const listing = await loadOwned(tx, user, id);
    if (listing.status !== 'OPEN') throw conflict(`Cannot edit a ${listing.status.toLowerCase()} listing`);

    const touchesLocked = LOCKED_FIELDS.filter((f) => data[f] !== undefined);
    if (touchesLocked.length) {
      const holding = await tx.allocation.count({ where: { listingId: id, status: { in: LISTING_HOLDING } } });
      if (holding > 0) {
        throw conflict(`This listing already has allocations, so ${touchesLocked.join(', ')} cannot change. Withdraw it and create a new listing instead.`, { lockedFields: touchesLocked });
      }
      const category = await tx.foodCategory.findUnique({ where: { id: data.categoryId ?? listing.categoryId } });
      if (!category) throw badRequest('Unknown food category');
      checkDates({ preparedAt: data.preparedAt ?? listing.preparedAt, safeUntil: data.safeUntil ?? listing.safeUntil, collectionDeadline: data.collectionDeadline ?? listing.collectionDeadline }, category);
    }

    const updated = await tx.surplusListing.update({ where: { id }, data, include: LISTING_INCLUDE });
    return listingView(updated, await listingQuantity(tx, updated), true);
  });
}

/**
 * Donor withdraws a listing: it is CLOSED, offers that are proposed or accepted
 * (not yet picked up) are CANCELLED and their requests flagged for reallocation.
 * Food already picked up continues to its NGO.
 */
export async function withdrawListing(user, id, { reason } = {}) {
  const result = await withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    const listing = await loadOwned(tx, user, id);
    if (listing.status !== 'OPEN') throw conflict(`Listing is already ${listing.status.toLowerCase()}`);
    const why = reason ? `Listing withdrawn by donor: ${reason}` : 'Listing withdrawn by donor';
    const pending = await tx.allocation.findMany({ where: { listingId: id, status: { in: RELEASABLE } } });
    for (const a of pending) await releaseAllocationLocked(tx, a, { to: 'CANCELLED', reason: why, actorUserId: user.id });
    await tx.surplusListing.update({ where: { id }, data: { status: 'CLOSED' } });
    await recordTransition(tx, { entity: ENTITY.LISTING, entityId: id, from: 'OPEN', to: 'CLOSED', reason: why, actorUserId: user.id });
    return { listingId: id, cancelledAllocations: pending.length };
  });
  if (result.cancelledAllocations) triggerMatching('listing-withdrawn');
  return result;
}

/** Close a listing automatically once all of its food has finished moving. Call inside the lock. */
export async function closeListingIfDone(tx, listingId, actorUserId = null) {
  const listing = await tx.surplusListing.findUnique({ where: { id: listingId } });
  if (!listing || listing.status !== 'OPEN') return;
  const qty = await listingQuantity(tx, listing);
  if (qty.remaining === 0 && qty.inProgress === 0) {
    await tx.surplusListing.update({ where: { id: listingId }, data: { status: 'CLOSED' } });
    await recordTransition(tx, { entity: ENTITY.LISTING, entityId: listingId, from: 'OPEN', to: 'CLOSED', reason: 'All food allocated and handled', actorUserId });
  }
}

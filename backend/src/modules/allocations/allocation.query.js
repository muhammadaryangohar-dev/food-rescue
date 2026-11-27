// Read side of allocations: role-scoped lists, detail with score breakdown, timeline.
import { prisma } from '../../lib/prisma.js';
import { ownsListing, ownsRequest } from '../../lib/access.js';
import { canSeeExactListing, maskLocation } from '../../lib/privacy.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { ENTITY } from '../../lib/history.js';

const ALLOC_INCLUDE = {
  listing: {
    include: {
      category: true,
      organisation: { select: { id: true, name: true } },
      event: { select: { id: true, name: true, organisationId: true } },
    },
  },
  request: { include: { ngo: { select: { id: true, name: true, area: true } }, category: true } },
  task: { select: { id: true, status: true, collectorType: true, volunteerId: true, claimDeadline: true } },
};

export function canViewAllocation(user, allocation) {
  if (user.role === 'ADMIN') return true;
  if (ownsListing(user, allocation.listing)) return true;
  if (ownsRequest(user, allocation.request)) return true;
  if (user.role === 'VOLUNTEER' && allocation.task?.volunteerId && allocation.task.volunteerId === user.volunteerProfile?.id) return true;
  return false;
}

async function view(user, a) {
  const exact = await canSeeExactListing(prisma, user, a.listing);
  return { ...a, listing: maskLocation(a.listing, exact) };
}

export async function listAllocations(user, { status, requestId, listingId }) {
  const where = {};
  if (status) where.status = { in: status.split(',') };
  if (requestId) where.requestId = requestId;
  if (listingId) where.listingId = listingId;

  if (user.role === 'NGO') where.request = { ngoId: user.organisationId };
  else if (user.role === 'DONOR') {
    where.listing = { organisationId: user.organisationId ?? -1 };
  } else if (user.role === 'VOLUNTEER') where.task = { volunteerId: user.volunteerProfile?.id ?? -1 };

  const rows = await prisma.allocation.findMany({ where, include: ALLOC_INCLUDE, orderBy: { proposedAt: 'desc' }, take: 200 });
  return Promise.all(rows.map((a) => view(user, a)));
}

export async function getAllocation(user, id) {
  const a = await prisma.allocation.findUnique({ where: { id }, include: ALLOC_INCLUDE });
  if (!a) throw notFound('Allocation');
  if (!canViewAllocation(user, a)) throw forbidden('You are not involved in this allocation');
  return view(user, a);
}

/** Status timeline (FR11): every transition of the allocation, its task, listing and request. */
export async function getTimeline(user, id) {
  const a = await prisma.allocation.findUnique({ where: { id }, include: ALLOC_INCLUDE });
  if (!a) throw notFound('Allocation');
  if (!canViewAllocation(user, a)) throw forbidden('You are not involved in this allocation');

  const or = [
    { entity: ENTITY.ALLOCATION, entityId: a.id },
    { entity: ENTITY.LISTING, entityId: a.listingId },
    { entity: ENTITY.REQUEST, entityId: a.requestId },
  ];
  if (a.task) or.push({ entity: ENTITY.TASK, entityId: a.task.id });
  const history = await prisma.statusHistory.findMany({
    where: { OR: or },
    include: { actor: { select: { id: true, name: true, role: true } } },
    orderBy: { time: 'asc' },
  });
  return history.map((h) => ({
    id: h.id,
    entity: h.entity,
    entityId: h.entityId,
    from: h.fromStatus,
    to: h.toStatus,
    reason: h.reason,
    time: h.time,
    actor: h.actor ? { name: h.actor.name, role: h.actor.role } : { name: 'System', role: 'SYSTEM' },
  }));
}

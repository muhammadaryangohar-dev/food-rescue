// M11 issue reports: any involved party can report a problem; an admin resolves it.
// An UPHELD report can reverse a delivery ("reports can reverse deliveries").
import { prisma, TX_OPTIONS } from '../../lib/prisma.js';
import { withAllocationLock } from '../../lib/lock.js';
import { recordTransition, ENTITY } from '../../lib/history.js';
import { notifyUsers, adminUserIds, orgUserIds, listingDonorUserIds } from '../../lib/notify.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { canViewAllocation } from '../allocations/allocation.query.js';
import { triggerMatching } from '../matching/matching.trigger.js';

const ALLOC_FOR_ACCESS = {
  listing: { include: { event: { select: { organisationId: true } } } },
  request: true,
  task: { select: { id: true, volunteerId: true, status: true, volunteer: { select: { userId: true } } } },
};

export async function createReport(user, { allocationId, type, description }) {
  const allocation = await prisma.allocation.findUnique({ where: { id: allocationId }, include: ALLOC_FOR_ACCESS });
  if (!allocation) throw notFound('Allocation');
  if (!canViewAllocation(user, allocation)) throw forbidden('You can only report on allocations you are involved in');

  return prisma.$transaction(async (tx) => {
    const report = await tx.report.create({ data: { reporterId: user.id, allocationId, type, description } });
    await recordTransition(tx, { entity: ENTITY.REPORT, entityId: report.id, from: null, to: 'OPEN', reason: `${type}: ${description.slice(0, 100)}`, actorUserId: user.id });
    await notifyUsers(tx, await adminUserIds(tx), { type: 'REPORT_FILED', message: `New ${type.toLowerCase().replace('_', ' ')} report on allocation #${allocationId}.`, link: `/admin/reports/${report.id}` });
    return report;
  }, TX_OPTIONS);
}

export async function listReports(user, { status }) {
  const where = {};
  if (status) where.status = status;
  if (user.role !== 'ADMIN') where.reporterId = user.id;
  return prisma.report.findMany({
    where,
    include: {
      reporter: { select: { id: true, name: true, role: true } },
      resolvedBy: { select: { id: true, name: true } },
      allocation: { select: { id: true, status: true, quantity: true, listingId: true, requestId: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

/**
 * Admin resolves a report as UPHELD or DISMISSED.
 *  - reverseDelivery: an UPHELD report against a DELIVERED allocation (e.g. the food
 *    never actually arrived) turns it into FAILED, so it stops counting as Rescued.
 *  - NO_SHOW upheld: the volunteer's no-show count goes up.
 */
export async function resolveReport(admin, id, { status, resolutionNote, reverseDelivery = false }) {
  const result = await withAllocationLock(async (tx) => {
    const report = await tx.report.findUnique({ where: { id }, include: { allocation: { include: ALLOC_FOR_ACCESS } } });
    if (!report) throw notFound('Report');
    if (report.status !== 'OPEN') throw conflict('Report is already resolved');
    if (reverseDelivery && status !== 'UPHELD') throw badRequest('Only an upheld report can reverse a delivery');

    await tx.report.update({ where: { id }, data: { status, resolutionNote, resolvedById: admin.id, resolvedAt: new Date() } });
    await recordTransition(tx, { entity: ENTITY.REPORT, entityId: id, from: 'OPEN', to: status, reason: resolutionNote, actorUserId: admin.id });

    const a = report.allocation;
    let reversed = false;
    if (reverseDelivery) {
      if (a.status !== 'DELIVERED') throw conflict('Only a delivered allocation can be reversed');
      await tx.allocation.update({ where: { id: a.id }, data: { status: 'FAILED', lostQuantity: a.quantity, decisionReason: `Delivery reversed by report #${id}` } });
      await recordTransition(tx, { entity: ENTITY.ALLOCATION, entityId: a.id, from: 'DELIVERED', to: 'FAILED', reason: `Delivery reversed after report #${id}: ${resolutionNote}`, actorUserId: admin.id });
      // The request's need opens again if the request was marked fulfilled because of it
      const request = await tx.nGORequest.findUnique({ where: { id: a.requestId } });
      if (request.status === 'FULFILLED') {
        const reopen = request.requiredBy > new Date();
        await tx.nGORequest.update({ where: { id: request.id }, data: { status: reopen ? 'OPEN' : 'EXPIRED', reallocationPending: reopen } });
        await recordTransition(tx, { entity: ENTITY.REQUEST, entityId: request.id, from: 'FULFILLED', to: reopen ? 'OPEN' : 'EXPIRED', reason: `Delivery reversed by report #${id}`, actorUserId: admin.id });
      }
      reversed = true;
    }
    if (status === 'UPHELD' && report.type === 'NO_SHOW' && a.task?.volunteerId) {
      await tx.volunteerProfile.update({ where: { id: a.task.volunteerId }, data: { noShowCount: { increment: 1 } } });
    }

    await notifyUsers(tx, [report.reporterId, ...(await orgUserIds(tx, a.request.ngoId)), ...(await listingDonorUserIds(tx, a.listing)), a.task?.volunteer?.userId], {
      type: 'REPORT_RESOLVED',
      message: `Report #${id} on allocation #${a.id} was ${status.toLowerCase()}${reversed ? ' and the delivery was reversed' : ''}.`,
      link: `/allocations/${a.id}`,
    });
    return { report: await tx.report.findUnique({ where: { id } }), reversed };
  });
  if (result.reversed) triggerMatching('delivery-reversed');
  return result;
}

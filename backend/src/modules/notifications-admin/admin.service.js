// M12 admin controls + FR2 verification and administration.
import { prisma } from '../../lib/prisma.js';
import { withAllocationLock } from '../../lib/lock.js';
import { recordTransition, ENTITY } from '../../lib/history.js';
import { notifyUsers, orgUserIds } from '../../lib/notify.js';
import { getAllConfig, invalidateConfigCache } from '../../lib/config.js';
import { CONFIG_DEFAULTS } from '../../config/defaults.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { publicUser, licenceExpired } from '../../lib/access.js';
import { createAllocation } from '../allocations/allocation.service.js';
import { runSweep } from '../allocations/sweep.service.js';
import { runMatchingNow } from '../matching/matching.trigger.js';

// ---------------------------------------------------------------- verification

// Donor businesses show their food licence so the admin can check it before approving.
export async function pendingVerifications(status = 'PENDING') {
  const [organisations, volunteers] = await Promise.all([
    prisma.organisation.findMany({ where: { verificationStatus: status }, include: { users: { select: { id: true, name: true, email: true, phone: true } } }, orderBy: { createdAt: 'asc' } }),
    prisma.volunteerProfile.findMany({ where: { approvalStatus: status }, include: { user: { select: { id: true, name: true, email: true, phone: true } } } }),
  ]);
  return {
    organisations: organisations.map((o) => (o.type === 'NGO' ? o : { ...o, licenceExpired: licenceExpired(o) })),
    volunteers,
  };
}

const VERIFY_MESSAGE = { VERIFIED: 'has been verified. You can now use FoodRescue fully.', REJECTED: 'was not approved. Contact an administrator for details.', PENDING: 'is pending review again.' };

export async function setOrganisationVerification(id, status) {
  const current = await prisma.organisation.findUnique({ where: { id } });
  if (!current) throw notFound('Organisation');
  // Only licensed businesses donate: an expired licence cannot be approved
  if (status === 'VERIFIED' && current.type !== 'NGO' && licenceExpired(current)) {
    throw badRequest(`The food licence of "${current.name}" expired on ${current.licenceExpiresOn.toISOString().slice(0, 10)}. Ask the business to upload a renewed licence first.`);
  }
  const org = await prisma.organisation.update({ where: { id }, data: { verificationStatus: status } });
  await notifyUsers(prisma, await orgUserIds(prisma, id), { type: 'VERIFICATION', message: `Your organisation "${org.name}" ${VERIFY_MESSAGE[status]}` });
  return org;
}

export async function setVolunteerApproval(id, status, resetNoShows = false) {
  const v = await prisma.volunteerProfile.update({ where: { id }, data: { approvalStatus: status, ...(resetNoShows ? { noShowCount: 0 } : {}) } });
  await notifyUsers(prisma, [v.userId], { type: 'VERIFICATION', message: `Your volunteer account ${VERIFY_MESSAGE[status]}` });
  return v;
}

// ---------------------------------------------------------------- users

export async function listUsers({ role, active }) {
  const where = {};
  if (role) where.role = role;
  if (active !== undefined) where.active = active === 'true';
  const users = await prisma.user.findMany({
    where,
    include: { organisation: { select: { id: true, name: true, type: true, verificationStatus: true } }, volunteerProfile: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return users.map(publicUser);
}

export async function setUserActive(admin, id, active) {
  if (admin.id === id && !active) throw badRequest('You cannot deactivate your own account');
  const user = await prisma.user.update({ where: { id }, data: { active } });
  return publicUser(user);
}

// ---------------------------------------------------------------- config panel

export async function getConfigView() {
  const values = await getAllConfig();
  const rows = await prisma.systemConfig.findMany({ include: { updatedBy: { select: { name: true } } } });
  const meta = Object.fromEntries(rows.map((r) => [r.key, r]));
  return Object.keys(values).sort().map((key) => ({
    key,
    value: values[key],
    description: meta[key]?.description ?? CONFIG_DEFAULTS[key]?.description ?? null,
    default: CONFIG_DEFAULTS[key]?.value ?? null,
    updatedBy: meta[key]?.updatedBy?.name ?? null,
    updatedAt: meta[key]?.updatedAt ?? null,
  }));
}

export async function setConfig(admin, key, value) {
  if (CONFIG_DEFAULTS[key] && Number.isNaN(Number(value))) throw badRequest(`${key} must be a number`);
  if (CONFIG_DEFAULTS[key] && Number(value) < 0) throw badRequest(`${key} cannot be negative`);
  const row = await prisma.systemConfig.upsert({
    where: { key },
    update: { value: String(value), updatedById: admin.id },
    create: { key, value: String(value), description: CONFIG_DEFAULTS[key]?.description, updatedById: admin.id },
  });
  invalidateConfigCache();
  return row;
}

// ---------------------------------------------------------------- engine controls

export const runSweepNow = () => runSweep();
export const runMatching = () => runMatchingNow('admin');

/** Manual allocation tool (also used by the concurrency demo). Goes through every rule and the lock. */
export function manualAllocation(admin, { listingId, requestId, quantity, explanation }) {
  return createAllocation({ listingId, requestId, quantity, explanation: explanation || 'Manual allocation by administrator', actorUserId: admin.id });
}

/**
 * Expiry simulation (M12): move one deadline into the past, then run the sweep, so
 * the demo can show expiry and reallocation without waiting hours.
 */
export async function simulateExpiry(admin, { listingId, allocationId, requestId, taskId }) {
  const past = new Date(Date.now() - 60_000);
  const note = 'Deadline moved to the past by expiry simulation';

  await withAllocationLock(async (tx) => {
    if (allocationId) {
      const a = await tx.allocation.findUnique({ where: { id: allocationId }, include: { listing: true } });
      if (!a) throw notFound('Allocation');
      if (a.status === 'PROPOSED') await tx.allocation.update({ where: { id: a.id }, data: { responseDeadline: past } });
      else if (a.status === 'ACCEPTED') await tx.allocation.update({ where: { id: a.id }, data: { pickupDeadline: past } });
      else if (a.status === 'PICKED_UP') await tx.surplusListing.update({ where: { id: a.listingId }, data: { safeUntil: past, collectionDeadline: past } });
      else throw badRequest(`Nothing to expire on a ${a.status.toLowerCase()} allocation`);
      await recordTransition(tx, { entity: ENTITY.ALLOCATION, entityId: a.id, from: a.status, to: a.status, reason: note, actorUserId: admin.id });
    }
    if (listingId) {
      const l = await tx.surplusListing.findUnique({ where: { id: listingId } });
      if (!l) throw notFound('Listing');
      await tx.surplusListing.update({ where: { id: listingId }, data: { collectionDeadline: past } });
    }
    if (requestId) {
      const r = await tx.nGORequest.findUnique({ where: { id: requestId } });
      if (!r) throw notFound('Request');
      await tx.nGORequest.update({ where: { id: requestId }, data: { requiredBy: past } });
    }
    if (taskId) {
      const t = await tx.rescueTask.findUnique({ where: { id: taskId } });
      if (!t) throw notFound('Task');
      if (t.status !== 'CLAIMED') throw badRequest('Only a claimed task can be simulated as a no-show');
      await tx.rescueTask.update({ where: { id: taskId }, data: { claimDeadline: past } });
    }
  });

  return { simulated: true, sweep: await runSweep() };
}

// M7 Rescue: rescue tasks, volunteer claim, OTP pickup and delivery, self-collect,
// partial quantities and quality rejection.
//
// Every state change runs under the allocation lock, so two volunteers pressing
// "Claim" at the same moment can never both get the task (claim race, CP4), and a
// pickup can never happen on an offer that was just cancelled.
import { prisma } from '../../lib/prisma.js';
import { withAllocationLock } from '../../lib/lock.js';
import { recordTransition, ENTITY } from '../../lib/history.js';
import { notifyUsers, orgUserIds, listingDonorUserIds, adminUserIds } from '../../lib/notify.js';
import { getNumber } from '../../lib/config.js';
import { deriveOtp, otpMatches } from '../../lib/otp.js';
import { ownsListing, ownsRequest, isCollector, isVerified } from '../../lib/access.js';
import { maskLocation } from '../../lib/privacy.js';
import { haversineKm } from '../../lib/haversine.js';
import { AppError, badRequest, conflict, forbidden, gone, locked, notFound } from '../../lib/errors.js';
import { sweepLocked } from '../allocations/sweep.service.js';
import { closeListingIfDone, urgency } from '../listings/listing.service.js';
import { fulfilIfComplete } from '../matching/request.service.js';
import { triggerMatching } from '../matching/matching.trigger.js';

export const TASK_INCLUDE = {
  allocation: {
    include: {
      listing: {
        include: {
          category: true,
          organisation: { select: { id: true, name: true } },
          event: { select: { id: true, name: true, organisationId: true } },
        },
      },
      request: { include: { ngo: true } },
    },
  },
  volunteer: { include: { user: { select: { id: true, name: true, phone: true } } } },
  handovers: { orderBy: { recordedAt: 'asc' } },
};

const ACTIVE_TASK = ['OPEN', 'CLAIMED', 'PICKED_UP', 'LOCKED'];
const minutesFromNow = (m) => new Date(Date.now() + m * 60_000);
const earliest = (...d) => new Date(Math.min(...d.filter(Boolean).map((x) => new Date(x).getTime())));

export async function loadTask(tx, id) {
  const task = await tx.rescueTask.findUnique({ where: { id }, include: TASK_INCLUDE });
  if (!task) throw notFound('Task');
  return task;
}

function roleInTask(user, task) {
  const { listing, request } = task.allocation;
  if (user.role === 'ADMIN') return 'ADMIN';
  if (ownsListing(user, listing)) return 'DONOR';
  if (ownsRequest(user, request)) return 'NGO';
  if (user.role === 'VOLUNTEER' && task.volunteerId && task.volunteerId === user.volunteerProfile?.id) return 'COLLECTOR';
  return null;
}

// ---------------------------------------------------------------- views

/**
 * Task view with privacy rules (NFR8):
 *  - exact pickup/drop-off addresses and phone numbers only for involved parties,
 *    and only while the task is active
 *  - pickup code only for the donor side, delivery code only for the NGO
 */
export async function taskView(user, task) {
  const role = roleInTask(user, task);
  const active = ACTIVE_TASK.includes(task.status);
  const { listing, request } = task.allocation;
  const exact = role === 'ADMIN' || (active && role !== null && (role !== 'COLLECTOR' || task.status !== 'OPEN'));

  const donorUser = exact ? await prisma.user.findUnique({ where: { id: listing.createdById }, select: { name: true, phone: true } }) : null;
  const ngoContact = exact ? await prisma.user.findFirst({ where: { organisationId: request.ngoId, active: true }, select: { name: true, phone: true } }) : null;

  const codes = {};
  // Codes are visible ONLY to the donor (pickup) and the NGO (delivery), never to
  // admins or the collector: the collector must receive them in person at handover.
  if (active && task.status !== 'PICKED_UP' && role === 'DONOR') codes.pickupCode = deriveOtp(task.otpNonce, 'PICKUP');
  if (active && role === 'NGO') codes.deliveryCode = deriveOtp(task.otpNonce, 'DELIVERY');

  const { pickupOtpHash, deliveryOtpHash, otpNonce, ...safeTask } = task;
  const distanceKm = haversineKm(listing.latitude, listing.longitude, request.ngo.latitude, request.ngo.longitude);

  return {
    ...safeTask,
    ...urgency(listing.safeUntil),
    yourRole: role,
    codes,
    distanceKm: distanceKm === null ? null : Math.round(distanceKm * 10) / 10,
    allocation: {
      ...task.allocation,
      listing: maskLocation(listing, exact),
      request: {
        id: request.id,
        requiredBy: request.requiredBy,
        ngo: maskLocation({ id: request.ngo.id, name: request.ngo.name, address: request.ngo.address, area: request.ngo.area, latitude: request.ngo.latitude, longitude: request.ngo.longitude }, exact),
      },
    },
    volunteer: task.volunteer ? { id: task.volunteer.id, name: task.volunteer.user.name, phone: exact ? task.volunteer.user.phone : null } : null,
    contacts: exact ? { donor: donorUser, ngo: ngoContact } : null,
  };
}

export async function listAvailableTasks(user) {
  if (!isVerified(user)) throw forbidden('Your volunteer account is waiting for approval');
  const tasks = await prisma.rescueTask.findMany({
    where: { status: 'OPEN', collectorType: 'VOLUNTEER', allocation: { status: 'ACCEPTED' } },
    include: TASK_INCLUDE,
    // Most urgent food first (near-expiry tasks at the top)
    orderBy: { allocation: { listing: { safeUntil: 'asc' } } },
  });
  return Promise.all(tasks.map((t) => taskView(user, t)));
}

export async function listMyTasks(user, { status }) {
  const where = {};
  if (status) where.status = { in: status.split(',') };
  if (user.role === 'VOLUNTEER') where.volunteerId = user.volunteerProfile?.id ?? -1;
  else if (user.role === 'NGO') where.allocation = { request: { ngoId: user.organisationId } };
  else if (user.role === 'DONOR') {
    where.allocation = {
      listing: { organisationId: user.organisationId ?? -1 },
    };
  }
  const tasks = await prisma.rescueTask.findMany({ where, include: TASK_INCLUDE, orderBy: { updatedAt: 'desc' }, take: 200 });
  return Promise.all(tasks.map((t) => taskView(user, t)));
}

export async function getTask(user, id) {
  const task = await loadTask(prisma, id);
  const role = roleInTask(user, task);
  const openForVolunteers = user.role === 'VOLUNTEER' && task.status === 'OPEN' && task.collectorType === 'VOLUNTEER';
  if (!role && !openForVolunteers) throw forbidden('You are not involved in this task');
  return taskView(user, task);
}

// ---------------------------------------------------------------- claim

/** Can this volunteer claim at all? (approved, under the no-show limit) */
export async function assertCanClaim(user) {
  if (!isVerified(user)) throw forbidden('Your volunteer account is waiting for approval');
  const limit = await getNumber('VOLUNTEER_NO_SHOW_LIMIT');
  if (user.volunteerProfile.noShowCount >= limit) throw forbidden('You have too many no-shows to claim new tasks. Contact an administrator.');
}

/**
 * Claim one task. Caller MUST hold the allocation lock. `extraMinutes` gives later
 * stops of a pooled trip more time (travel time to reach them).
 */
export async function claimTaskLocked(tx, user, id, { extraMinutes = 0, tripNote = '' } = {}) {
  const task = await loadTask(tx, id);
  if (task.collectorType !== 'VOLUNTEER') throw conflict('The NGO is collecting this food itself');
  if (task.status !== 'OPEN') throw conflict(task.volunteerId === user.volunteerProfile.id ? 'You already claimed this task' : 'Another volunteer has already claimed this task');
  if (task.allocation.status !== 'ACCEPTED') throw gone('This task is no longer available');

  const claimMinutes = await getNumber('CLAIM_WINDOW_MINUTES', tx);
  const claimDeadline = earliest(minutesFromNow(claimMinutes + extraMinutes), task.allocation.pickupDeadline);
  await tx.rescueTask.update({ where: { id }, data: { status: 'CLAIMED', volunteerId: user.volunteerProfile.id, claimDeadline } });
  await recordTransition(tx, { entity: ENTITY.TASK, entityId: id, from: 'OPEN', to: 'CLAIMED', reason: `Claimed by volunteer ${user.name}${tripNote}`, actorUserId: user.id });

  const { listing, request } = task.allocation;
  await notifyUsers(tx, [...(await listingDonorUserIds(tx, listing)), ...(await orgUserIds(tx, request.ngoId))], {
    type: 'TASK_CLAIMED',
    message: `Volunteer ${user.name} will collect ${task.allocation.quantity} servings (task #${id}${tripNote}).`,
    link: `/tasks/${id}`,
  });
}

export async function claimTask(user, id) {
  await assertCanClaim(user);
  await withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    await claimTaskLocked(tx, user, id);
  });
  // Build the response AFTER the lock is released (taskView runs extra queries)
  return taskView(user, await loadTask(prisma, id));
}

export async function unclaimTask(user, id) {
  await withAllocationLock(async (tx) => {
    const task = await loadTask(tx, id);
    if (task.volunteerId !== user.volunteerProfile?.id) throw forbidden('This is not your task');
    if (task.status !== 'CLAIMED') throw conflict(`Cannot release a task that is ${task.status.toLowerCase()}`);
    await tx.rescueTask.update({ where: { id }, data: { status: 'OPEN', volunteerId: null, claimDeadline: null } });
    await recordTransition(tx, { entity: ENTITY.TASK, entityId: id, from: 'CLAIMED', to: 'OPEN', reason: 'Volunteer released the task', actorUserId: user.id });
    await notifyUsers(tx, await orgUserIds(tx, task.allocation.request.ngoId), { type: 'TASK_RELEASED', message: `The volunteer released task #${id}; it is open again.`, link: `/tasks/${id}` });
  });
  return taskView(user, await loadTask(prisma, id));
}

// ---------------------------------------------------------------- OTP handovers

/**
 * Shared OTP check. Wrong codes must be COUNTED even though the request fails, so
 * instead of throwing inside the transaction (which would roll the count back) this
 * returns an error object; the caller throws it after the transaction commits.
 */
async function checkOtp(tx, task, code, type, user) {
  if (task.status === 'LOCKED') return locked('Too many wrong codes. This task is locked; an administrator must unlock it.');
  if (task.otpExpiresAt <= new Date()) return gone('The code has expired because the food is past its safe-until time');
  const hash = type === 'PICKUP' ? task.pickupOtpHash : task.deliveryOtpHash;
  if (otpMatches(code, hash)) return null;

  const max = await getNumber('OTP_MAX_ATTEMPTS', tx);
  const attempts = task.failedAttempts + 1;
  if (attempts >= max) {
    await tx.rescueTask.update({ where: { id: task.id }, data: { failedAttempts: attempts, status: 'LOCKED' } });
    await recordTransition(tx, { entity: ENTITY.TASK, entityId: task.id, from: task.status, to: 'LOCKED', reason: `${attempts} wrong ${type.toLowerCase()} codes`, actorUserId: user.id });
    await notifyUsers(tx, await adminUserIds(tx), { type: 'TASK_LOCKED', message: `Task #${task.id} was locked after ${attempts} wrong codes.`, link: `/admin/tasks/${task.id}` });
    return locked('Too many wrong codes. The task is now locked; an administrator must unlock it.');
  }
  await tx.rescueTask.update({ where: { id: task.id }, data: { failedAttempts: attempts } });
  return new AppError(400, 'WRONG_CODE', `Wrong code. ${max - attempts} attempt(s) left.`, { attemptsLeft: max - attempts });
}

/** Collector confirms pickup with the donor's code. Partial pickups record the shortfall as lost. */
export async function confirmPickup(user, id, { code, quantity }) {
  const out = await withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    const task = await loadTask(tx, id);
    const { allocation } = task;
    if (!isCollector(user, task, allocation.request)) throw forbidden('Only the assigned collector can confirm pickup');

    // Idempotent: a repeated request after success returns the same result
    if (task.handovers.some((h) => h.type === 'PICKUP')) return { alreadyRecorded: true };
    if (task.status === 'CANCELLED' || allocation.status !== 'ACCEPTED') throw gone('This task was cancelled or expired');
    if (task.status !== 'CLAIMED' && task.status !== 'LOCKED') throw conflict(`Task is ${task.status.toLowerCase()}`);

    const error = await checkOtp(tx, task, code, 'PICKUP', user);
    if (error) return { error };
    if (quantity > allocation.quantity) throw badRequest(`You can pick up at most ${allocation.quantity} servings`);

    await tx.handoverRecord.create({ data: { taskId: id, type: 'PICKUP', quantity, recordedById: user.id } });
    await tx.rescueTask.update({ where: { id }, data: { status: 'PICKED_UP', failedAttempts: 0 } });
    await tx.allocation.update({ where: { id: allocation.id }, data: { status: 'PICKED_UP', lostQuantity: allocation.quantity - quantity } });
    const partial = quantity < allocation.quantity ? ` (partial: ${quantity} of ${allocation.quantity})` : '';
    await recordTransition(tx, { entity: ENTITY.TASK, entityId: id, from: 'CLAIMED', to: 'PICKED_UP', reason: `Pickup verified by code${partial}`, actorUserId: user.id });
    await recordTransition(tx, { entity: ENTITY.ALLOCATION, entityId: allocation.id, from: 'ACCEPTED', to: 'PICKED_UP', reason: `Picked up ${quantity} servings${partial}`, actorUserId: user.id });
    await notifyUsers(tx, [...(await listingDonorUserIds(tx, allocation.listing)), ...(await orgUserIds(tx, allocation.request.ngoId))], {
      type: 'PICKED_UP',
      message: `${quantity} servings picked up for task #${id}${partial}. On the way to ${allocation.request.ngo.name}.`,
      link: `/tasks/${id}`,
    });
    return {};
  });
  if (out.error) throw out.error;
  return { task: await taskView(user, await loadTask(prisma, id)), alreadyRecorded: !!out.alreadyRecorded };
}

/** Collector confirms delivery with the NGO's code. Only verified deliveries count as Rescued. */
export async function confirmDelivery(user, id, { code, quantity }) {
  const out = await withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    const task = await loadTask(tx, id);
    const { allocation } = task;
    if (!isCollector(user, task, allocation.request)) throw forbidden('Only the assigned collector can confirm delivery');

    if (task.handovers.some((h) => h.type === 'DELIVERY')) return { alreadyRecorded: true };
    if (allocation.status !== 'PICKED_UP') throw conflict(allocation.status === 'FAILED' ? 'This delivery already failed' : 'Food has not been picked up yet');
    if (task.status !== 'PICKED_UP' && task.status !== 'LOCKED') throw conflict(`Task is ${task.status.toLowerCase()}`);

    const error = await checkOtp(tx, task, code, 'DELIVERY', user);
    if (error) return { error };
    const pickedUp = allocation.quantity - allocation.lostQuantity;
    if (quantity > pickedUp) throw badRequest(`Only ${pickedUp} servings were picked up`);

    await tx.handoverRecord.create({ data: { taskId: id, type: 'DELIVERY', quantity, recordedById: user.id } });
    await tx.rescueTask.update({ where: { id }, data: { status: 'DELIVERED', failedAttempts: 0 } });
    await tx.allocation.update({ where: { id: allocation.id }, data: { status: 'DELIVERED', lostQuantity: allocation.quantity - quantity } });
    const partial = quantity < pickedUp ? ` (${pickedUp - quantity} servings lost on the way)` : '';
    await recordTransition(tx, { entity: ENTITY.TASK, entityId: id, from: 'PICKED_UP', to: 'DELIVERED', reason: `Delivery verified by code${partial}`, actorUserId: user.id });
    await recordTransition(tx, { entity: ENTITY.ALLOCATION, entityId: allocation.id, from: 'PICKED_UP', to: 'DELIVERED', reason: `Delivered ${quantity} servings${partial}`, actorUserId: user.id });

    await fulfilIfComplete(tx, allocation.requestId, user.id);
    await closeListingIfDone(tx, allocation.listingId, user.id);
    await notifyUsers(tx, [...(await listingDonorUserIds(tx, allocation.listing)), ...(await orgUserIds(tx, allocation.request.ngoId))], {
      type: 'DELIVERED',
      message: `${quantity} servings delivered to ${allocation.request.ngo.name} (task #${id}). Thank you!`,
      link: `/tasks/${id}`,
    });
    return {};
  });
  if (out.error) throw out.error;
  return { task: await taskView(user, await loadTask(prisma, id)), alreadyRecorded: !!out.alreadyRecorded };
}

/**
 * The NGO refuses the food on arrival because of its quality (FR10 "rejected
 * handovers are recorded"). The allocation FAILS, all of it counts as Lost, and the
 * request's need opens again for reallocation.
 */
export async function rejectForQuality(user, id, { reason }) {
  await withAllocationLock(async (tx) => {
    const task = await loadTask(tx, id);
    const { allocation } = task;
    if (user.role !== 'ADMIN' && !ownsRequest(user, allocation.request)) throw forbidden('Only the receiving NGO can reject the food');
    if (allocation.status !== 'PICKED_UP') throw conflict('Food can only be rejected when it arrives (after pickup)');

    await tx.allocation.update({ where: { id: allocation.id }, data: { status: 'FAILED', lostQuantity: allocation.quantity, decisionReason: `Quality rejection: ${reason}` } });
    await tx.rescueTask.update({ where: { id }, data: { status: 'CANCELLED' } });
    await recordTransition(tx, { entity: ENTITY.ALLOCATION, entityId: allocation.id, from: 'PICKED_UP', to: 'FAILED', reason: `Rejected on arrival for quality: ${reason}`, actorUserId: user.id });
    await recordTransition(tx, { entity: ENTITY.TASK, entityId: id, from: task.status, to: 'CANCELLED', reason: 'Food rejected for quality', actorUserId: user.id });
    await tx.nGORequest.updateMany({ where: { id: allocation.requestId, status: 'OPEN' }, data: { reallocationPending: true } });
    await closeListingIfDone(tx, allocation.listingId, user.id);
    await notifyUsers(tx, [...(await listingDonorUserIds(tx, allocation.listing)), task.volunteer?.userId, ...(await adminUserIds(tx))], {
      type: 'QUALITY_REJECTED',
      message: `${allocation.request.ngo.name} rejected the food from task #${id} for quality: ${reason}`,
      link: `/tasks/${id}`,
    });
  });
  triggerMatching('quality-rejection');
  return taskView(user, await loadTask(prisma, id));
}

// ---------------------------------------------------------------- admin

/** Admin unlocks a task locked by wrong codes; it returns to the state it was in. */
export async function unlockTask(user, id) {
  await withAllocationLock(async (tx) => {
    const task = await loadTask(tx, id);
    if (task.status !== 'LOCKED') throw conflict('Task is not locked');
    let back = 'OPEN';
    if (task.handovers.some((h) => h.type === 'PICKUP')) back = 'PICKED_UP';
    else if (task.collectorType === 'NGO' || task.volunteerId) back = 'CLAIMED';
    await tx.rescueTask.update({ where: { id }, data: { status: back, failedAttempts: 0 } });
    await recordTransition(tx, { entity: ENTITY.TASK, entityId: id, from: 'LOCKED', to: back, reason: 'Unlocked by administrator', actorUserId: user.id });
    await notifyUsers(tx, [task.volunteer?.userId, ...(await orgUserIds(tx, task.allocation.request.ngoId))], { type: 'TASK_UNLOCKED', message: `Task #${id} was unlocked by an administrator.`, link: `/tasks/${id}` });
  });
  return taskView(user, await loadTask(prisma, id));
}

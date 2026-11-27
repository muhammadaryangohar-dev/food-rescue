// Combined pickup trip for pooled food (extra feature).
//
// When the matching engine pools several donors to fill ONE NGO request, each donor's
// food becomes its own rescue task. A "trip" groups the open volunteer tasks for the
// same request, so one volunteer can claim them together and gets the stops in a
// sensible order: pickups first (starting from the one farthest from the NGO, then
// always the nearest next pickup), and the NGO drop-off last.
//
// A trip is not stored: it is derived from the tasks (grouped by request), so there is
// no extra table and nothing that can get out of step with the tasks.
// Claiming a trip claims every task in ONE locked transaction: all or nothing.
import { prisma } from '../../lib/prisma.js';
import { withAllocationLock } from '../../lib/lock.js';
import { getNumber } from '../../lib/config.js';
import { haversineKm, travelMinutes } from '../../lib/haversine.js';
import { conflict, notFound } from '../../lib/errors.js';
import { sweepLocked } from '../allocations/sweep.service.js';
import { urgency } from '../listings/listing.service.js';
import { TASK_INCLUDE, taskView, assertCanClaim, claimTaskLocked } from './rescue.service.js';

const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);
const point = (o) => (o.latitude == null || o.longitude == null ? null : { latitude: o.latitude, longitude: o.longitude });
const km = (a, b) => (a && b ? haversineKm(a.latitude, a.longitude, b.latitude, b.longitude) : null);

/**
 * Order the pickups and work out leg distances. Returns the tasks in visiting order
 * with the cumulative travel minutes to reach each one (from the first pickup).
 */
export function planRoute(tasks, speedKmh) {
  const ngo = point(tasks[0].allocation.request.ngo);
  const located = tasks.filter((t) => point(t.allocation.listing));
  const unlocated = tasks.filter((t) => !point(t.allocation.listing));

  const order = [];
  if (located.length) {
    // Start from the pickup farthest from the NGO, so the route moves towards it
    const remaining = [...located].sort((a, b) => (km(point(b.allocation.listing), ngo) ?? 0) - (km(point(a.allocation.listing), ngo) ?? 0));
    order.push(remaining.shift());
    while (remaining.length) {
      const here = point(order.at(-1).allocation.listing);
      remaining.sort((a, b) => km(here, point(a.allocation.listing)) - km(here, point(b.allocation.listing)));
      order.push(remaining.shift());
    }
  }
  order.push(...unlocated); // no coordinates: visited last, distance unknown

  let totalKm = 0;
  let known = true;
  const legs = order.map((t, i) => {
    const from = i === 0 ? null : point(order[i - 1].allocation.listing);
    const leg = i === 0 ? 0 : km(from, point(t.allocation.listing));
    if (leg === null) known = false;
    totalKm += leg ?? 0;
    return { task: t, legKm: leg, minutesFromStart: known ? travelMinutes(totalKm, speedKmh) : null };
  });
  const lastLeg = km(point(order.at(-1).allocation.listing), ngo);
  if (lastLeg === null) known = false;
  totalKm += lastLeg ?? 0;

  return {
    legs,
    toNgoKm: round1(lastLeg),
    totalKm: known ? round1(totalKm) : null,
    totalMinutes: known ? Math.round(travelMinutes(totalKm, speedKmh)) : null,
  };
}

function groupByRequest(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    const key = t.allocation.requestId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.values()];
}

/** Area-level summary of a trip that has not been claimed yet (privacy, NFR8). */
function openTripView(tasks, speedKmh) {
  const route = planRoute(tasks, speedKmh);
  const { request } = tasks[0].allocation;
  return {
    requestId: request.id,
    ngo: { id: request.ngo.id, name: request.ngo.name, area: request.ngo.area },
    taskIds: route.legs.map((l) => l.task.id),
    totalServings: tasks.reduce((s, t) => s + t.allocation.quantity, 0),
    totalKm: route.totalKm,
    totalMinutes: route.totalMinutes,
    nearExpiry: tasks.some((t) => urgency(t.allocation.listing.safeUntil).nearExpiry),
    stops: [
      ...route.legs.map((l, i) => ({
        order: i + 1,
        type: 'PICKUP',
        taskId: l.task.id,
        donorName: l.task.allocation.listing.organisation?.name ?? 'Donor',
        area: l.task.allocation.listing.area,
        servings: l.task.allocation.quantity,
        collectBy: l.task.allocation.pickupDeadline,
        legKm: round1(l.legKm),
        ...urgency(l.task.allocation.listing.safeUntil),
      })),
      { order: route.legs.length + 1, type: 'DROPOFF', ngoName: request.ngo.name, area: request.ngo.area, legKm: route.toNgoKm },
    ],
  };
}

/** Pooled trips a volunteer can claim: 2 or more open tasks for the same NGO request. */
export async function listAvailableTrips(user) {
  await assertCanClaim(user);
  const speed = await getNumber('AVERAGE_SPEED_KMH');
  const tasks = await prisma.rescueTask.findMany({
    where: { status: 'OPEN', collectorType: 'VOLUNTEER', allocation: { status: 'ACCEPTED' } },
    include: TASK_INCLUDE,
  });
  return groupByRequest(tasks)
    .filter((g) => g.length >= 2)
    .map((g) => openTripView(g, speed))
    .sort((a, b) => Number(b.nearExpiry) - Number(a.nearExpiry) || b.totalServings - a.totalServings);
}

/**
 * Claim every task of a trip at once. `taskIds` is what the volunteer saw: if any of
 * them is no longer open, NOTHING is claimed (409) and the volunteer refreshes.
 */
export async function claimTrip(user, requestId, taskIds) {
  await assertCanClaim(user);
  const speed = await getNumber('AVERAGE_SPEED_KMH');
  await withAllocationLock(async (tx) => {
    await sweepLocked(tx);
    const tasks = await tx.rescueTask.findMany({ where: { id: { in: taskIds } }, include: TASK_INCLUDE });
    if (tasks.length !== taskIds.length) throw notFound('Task');
    if (tasks.some((t) => t.allocation.requestId !== requestId)) throw conflict('All tasks of a trip must deliver to the same NGO request');
    const busy = tasks.filter((t) => t.status !== 'OPEN' || t.collectorType !== 'VOLUNTEER' || t.allocation.status !== 'ACCEPTED');
    if (busy.length) {
      throw conflict(`Task${busy.length > 1 ? 's' : ''} ${busy.map((t) => `#${t.id}`).join(', ')} ${busy.length > 1 ? 'are' : 'is'} no longer available. Refresh the trip list.`, { code: 'TRIP_CHANGED', unavailable: busy.map((t) => t.id) });
    }
    // Later stops get the travel time to reach them added to their claim window
    const route = planRoute(tasks, speed);
    for (const [i, leg] of route.legs.entries()) {
      await claimTaskLocked(tx, user, leg.task.id, {
        extraMinutes: Math.round(leg.minutesFromStart ?? 15 * i),
        tripNote: `, stop ${i + 1} of ${route.legs.length} on a pooled trip`,
      });
    }
  });
  return (await listMyTrips(user)).find((t) => t.requestId === requestId);
}

/** The volunteer's own active trips (claimed or picked up), with full stop details. */
export async function listMyTrips(user) {
  const speed = await getNumber('AVERAGE_SPEED_KMH');
  const tasks = await prisma.rescueTask.findMany({
    where: { volunteerId: user.volunteerProfile?.id ?? -1, status: { in: ['CLAIMED', 'PICKED_UP'] } },
    include: TASK_INCLUDE,
  });
  const trips = [];
  for (const group of groupByRequest(tasks)) {
    const route = planRoute(group, speed);
    const { request } = group[0].allocation;
    trips.push({
      requestId: request.id,
      ngo: { id: request.ngo.id, name: request.ngo.name, area: request.ngo.area, address: request.ngo.address },
      totalServings: group.reduce((s, t) => s + t.allocation.quantity, 0),
      totalKm: route.totalKm,
      totalMinutes: route.totalMinutes,
      pickedUp: group.filter((t) => t.status === 'PICKED_UP').length,
      stops: [
        ...(await Promise.all(route.legs.map(async (l, i) => ({ order: i + 1, type: 'PICKUP', legKm: round1(l.legKm), task: await taskView(user, l.task) })))),
        { order: route.legs.length + 1, type: 'DROPOFF', ngoName: request.ngo.name, area: request.ngo.area, address: request.ngo.address, legKm: route.toNgoKm },
      ],
    });
  }
  return trips;
}

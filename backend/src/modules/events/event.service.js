// Events (M3, Member 2): marquees / caterers plan events, see how many servings are
// really needed, and after the event confirm leftovers, which become surplus listings.
//
// Event status: PLANNED -> COMPLETED (after it happens) -> CONFIRMED (leftovers confirmed,
// even if there were none). Every change writes a StatusHistory row.
//
// Marquee prevention (no new database columns): when a future event's food plan is first
// saved, each dish is written as a DailyFoodRecord on the event's date:
//   planned       = the dish's planned servings
//   forecastShown = the dish's share of the estimate shown (guests x servings per guest)
// When the event is completed the marquee enters what it actually cooked (prepared).
// The same Prevented rule as restaurants then applies (food-prevention/forecast.js), and
// the impact page counts it. The records are locked once written, like a restaurant's plan.
// Limitation: one record per dish per day, so if a marquee holds two events on the same
// day, only the first one's plan counts for Prevented.
import { prisma, TX_OPTIONS } from '../../lib/prisma.js';
import { recordTransition, ENTITY } from '../../lib/history.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { createListingTx } from '../listings/listing.service.js';
import { triggerMatching } from '../matching/matching.trigger.js';
import { pkToday } from '../../lib/time.js';
import { preventedServings } from '../food-prevention/forecast.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const EVENT_INCLUDE = {
  foodPlans: { include: { foodItem: { include: { category: true } } } },
  listings: { select: { id: true, description: true, confirmedQuantity: true, status: true, safeUntil: true, category: { select: { name: true } } } },
};

/** Needed servings vs planned servings for an event (the event version of the forecast). */
export function eventEstimate(event) {
  const needed = Math.ceil(Math.round(event.expectedGuests * event.servingsPerGuest * 100) / 100); // round first: 200 x 1.1 is 220.00000000000003 in floating point
  const planned = (event.foodPlans || []).reduce((s, p) => s + p.plannedServings, 0);
  const over = Math.max(0, planned - needed);
  const pct = needed > 0 ? Math.round((over / needed) * 100) : 0;
  return {
    neededServings: needed,
    plannedServings: planned,
    overPlanned: over,
    warning: over > 0 ? `You plan ${planned} servings for about ${needed} needed: about ${over} servings (${pct}%) may be left over.` : null,
  };
}

// ---------------------------------------------------------------- prevention records

const eventDay = (event) => pkToday(new Date(event.date));

/** Write the plan + estimate shown as daily food records (only for future events, never changed). */
async function snapshotPlan(tx, event, now = new Date()) {
  if (new Date(event.date) <= now || !event.foodPlans?.length) return 0;
  const { neededServings, plannedServings } = eventEstimate(event);
  if (plannedServings === 0) return 0;
  // Split the estimate across dishes in proportion to the plan; largest remainders get the
  // leftover servings so the dish shares add up exactly to the estimate shown.
  const exact = event.foodPlans.map((p) => (neededServings * p.plannedServings) / plannedServings);
  const shares = exact.map(Math.floor);
  let left = neededServings - shares.reduce((t, x) => t + x, 0);
  for (const i of exact.map((x, i) => i).sort((a, b) => exact[b] - shares[b] - (exact[a] - shares[a]) || a - b)) {
    if (left <= 0) break;
    shares[i] += 1;
    left -= 1;
  }
  const { count } = await tx.dailyFoodRecord.createMany({
    data: event.foodPlans.map((p, i) => ({
      foodItemId: p.foodItemId,
      date: eventDay(event),
      planned: p.plannedServings,
      forecastShown: shares[i],
    })),
    skipDuplicates: true, // an earlier plan for the same dish and day is kept (locked)
  });
  return count;
}

async function recordsFor(db, events) {
  const itemIds = [...new Set(events.flatMap((e) => (e.foodPlans || []).map((p) => p.foodItemId)))];
  if (itemIds.length === 0) return [];
  return db.dailyFoodRecord.findMany({ where: { foodItemId: { in: itemIds }, date: { in: events.map(eventDay) } } });
}

function preventionView(event, records) {
  const ids = new Set((event.foodPlans || []).map((p) => p.foodItemId));
  const day = eventDay(event).getTime();
  const mine = records.filter((r) => ids.has(r.foodItemId) && new Date(r.date).getTime() === day);
  if (mine.length === 0) {
    return { recorded: false, note: 'Prevention is recorded when the food plan is saved before the event.' };
  }
  const sum = (f) => mine.reduce((t, r) => t + (f(r) ?? 0), 0);
  const preparedKnown = mine.every((r) => r.prepared !== null);
  return {
    recorded: true,
    estimateShown: sum((r) => r.forecastShown),
    plannedAtEstimate: sum((r) => r.planned),
    prepared: preparedKnown ? sum((r) => r.prepared) : null,
    prevented: sum((r) => preventedServings(r)),
    dishes: mine.map((r) => ({ foodItemId: r.foodItemId, planned: r.planned, estimateShown: r.forecastShown, prepared: r.prepared, prevented: preventedServings(r) })),
  };
}

/** Save what was actually cooked per dish (on completion or with the leftovers). */
async function savePrepared(tx, event, prepared = []) {
  if (!prepared.length) return;
  const planned = new Set(event.foodPlans.map((p) => p.foodItemId));
  for (const p of prepared) if (!planned.has(p.foodItemId)) throw badRequest('Cooked amounts can only be entered for dishes in the food plan');
  for (const p of prepared) {
    await tx.dailyFoodRecord.updateMany({ where: { foodItemId: p.foodItemId, date: eventDay(event) }, data: { prepared: p.preparedServings } });
  }
}

async function viewMany(db, events) {
  const records = await recordsFor(db, events);
  return events.map((e) => ({ ...e, estimate: eventEstimate(e), prevention: preventionView(e, records) }));
}
const view = async (db, e) => (await viewMany(db, [e]))[0];

function requireMarquee(user) {
  if (user.role === 'DONOR' && user.donorType !== 'MARQUEE_CATERER') throw forbidden('Events are for marquees and caterers');
}

async function loadOwn(db, user, id) {
  const event = await db.event.findUnique({ where: { id }, include: EVENT_INCLUDE });
  if (!event) throw notFound('Event');
  if (user.role !== 'ADMIN' && event.organisationId !== user.organisationId) throw forbidden('This event is not yours');
  return event;
}

async function checkPlans(db, organisationId, plans = []) {
  const ids = [...new Set(plans.map((p) => p.foodItemId))];
  if (ids.length !== plans.length) throw badRequest('Each menu item can appear only once in a food plan');
  const own = await db.foodItem.count({ where: { id: { in: ids }, organisationId } });
  if (own !== ids.length) throw badRequest('Food plans can only use your own menu items');
}

export async function listEvents(user, { status } = {}) {
  requireMarquee(user);
  const where = { ...(status ? { status } : {}), ...(user.role === 'ADMIN' ? {} : { organisationId: user.organisationId }) };
  const events = await prisma.event.findMany({ where, include: EVENT_INCLUDE, orderBy: { date: 'desc' }, take: 200 });
  return viewMany(prisma, events);
}

export async function getEvent(user, id) {
  requireMarquee(user);
  return view(prisma, await loadOwn(prisma, user, id));
}

export async function createEvent(user, { plans = [], ...data }) {
  requireMarquee(user);
  await checkPlans(prisma, user.organisationId, plans);
  const event = await prisma.$transaction(async (tx) => {
    const e = await tx.event.create({ data: { ...data, organisationId: user.organisationId, foodPlans: { create: plans } }, include: EVENT_INCLUDE });
    await recordTransition(tx, { entity: ENTITY.EVENT, entityId: e.id, from: null, to: 'PLANNED', reason: 'Event planned', actorUserId: user.id });
    await snapshotPlan(tx, e);
    return view(tx, e);
  }, TX_OPTIONS);
  return event;
}

/** Edit a PLANNED event. `plans`, if given, replaces the whole food plan. */
export async function updateEvent(user, id, { plans, ...data }) {
  requireMarquee(user);
  const event = await prisma.$transaction(async (tx) => {
    const e = await loadOwn(tx, user, id);
    if (e.status !== 'PLANNED') throw conflict('Only a planned event can be edited');
    if (data.date && new Date(data.date).getTime() !== new Date(e.date).getTime() && preventionView(e, await recordsFor(tx, [e])).recorded) {
      throw conflict('The food plan for this date is already saved for the prevented-food counter, so the date cannot change. Create a new event instead.');
    }
    if (plans) {
      await checkPlans(tx, e.organisationId, plans);
      await tx.eventFoodPlan.deleteMany({ where: { eventId: id } });
      await tx.eventFoodPlan.createMany({ data: plans.map((p) => ({ ...p, eventId: id })) });
    }
    const updated = await tx.event.update({ where: { id }, data, include: EVENT_INCLUDE });
    await snapshotPlan(tx, updated); // dishes already recorded stay locked; new dishes are added
    return view(tx, updated);
  }, TX_OPTIONS);
  return event;
}

/** Mark the event as held (only once its date has passed), optionally with what was cooked per dish. */
export async function completeEvent(user, id, { prepared = [] } = {}) {
  requireMarquee(user);
  const event = await prisma.$transaction(async (tx) => {
    const e = await loadOwn(tx, user, id);
    if (e.status !== 'PLANNED') throw conflict(`Event is already ${e.status.toLowerCase()}`);
    if (e.date > new Date()) throw conflict('An event can be completed only after it has started');
    await savePrepared(tx, e, prepared);
    await recordTransition(tx, { entity: ENTITY.EVENT, entityId: id, from: 'PLANNED', to: 'COMPLETED', reason: 'Event held', actorUserId: user.id });
    const updated = await tx.event.update({ where: { id }, data: { status: 'COMPLETED' }, include: EVENT_INCLUDE });
    return view(tx, updated);
  }, TX_OPTIONS);
  return event;
}

/**
 * Confirm the actual leftovers after the event. Each leftover becomes a surplus listing
 * (source EVENT), all in one transaction, then the matching engine runs.
 * An empty list is allowed: "no leftovers" still confirms the event.
 * Defaults: prepared at the event time; safe for the category's default hours;
 * collection closes 1 hour before safe-until.
 */
export async function confirmLeftovers(user, id, { leftovers, safetyConfirmed, prepared = [] }) {
  requireMarquee(user);
  if (leftovers.length > 0 && safetyConfirmed !== true) throw badRequest('You must confirm the food is safe to eat');
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const e = await loadOwn(tx, user, id);
    if (e.status === 'CONFIRMED') throw conflict('Leftovers for this event are already confirmed');
    if (e.date > now) throw conflict('Leftovers can be confirmed only after the event has started');
    await savePrepared(tx, e, prepared);

    // Leftovers cannot be more than what was cooked (or, if that was not entered, planned)
    const total = leftovers.reduce((t, l) => t + l.quantity, 0);
    const prevention = preventionView(e, await recordsFor(tx, [e]));
    const cooked = prevention.recorded && prevention.prepared !== null ? prevention.prepared : null;
    const planned = eventEstimate(e).plannedServings;
    if (cooked !== null && total > cooked) throw badRequest(`Leftovers (${total} servings) cannot be more than the ${cooked} servings cooked`);
    if (cooked === null && planned > 0 && total > planned) throw badRequest(`Leftovers (${total} servings) cannot be more than the ${planned} servings planned`);

    const org = await tx.organisation.findUnique({ where: { id: e.organisationId } });

    const listings = [];
    for (const item of leftovers) {
      const category = await tx.foodCategory.findUnique({ where: { id: item.categoryId } });
      if (!category) throw badRequest('Unknown food category');
      const preparedAt = item.preparedAt ?? (e.date < now ? e.date : now);
      const safeUntil = item.safeUntil ?? new Date(preparedAt.getTime() + category.defaultSafeHours * HOUR);
      if (safeUntil <= now) throw badRequest(`${category.name} prepared at the event is no longer safe to donate`);
      const collectionDeadline = item.collectionDeadline ?? new Date(Math.max(safeUntil.getTime() - HOUR, Math.min(now.getTime() + 15 * MIN, safeUntil.getTime())));
      const listing = await createListingTx(
        tx,
        user,
        {
          categoryId: item.categoryId,
          description: item.description,
          confirmedQuantity: item.quantity,
          preparedAt,
          safeUntil,
          collectionDeadline,
          address: org.address,
          area: org.area,
          latitude: org.latitude,
          longitude: org.longitude,
          handlingNotes: item.handlingNotes,
          dietaryInfo: item.dietaryInfo,
        },
        { sourceType: 'EVENT', organisationId: e.organisationId, eventId: e.id },
      );
      listings.push(listing);
    }

    const reason = listings.length ? `Leftovers confirmed: ${listings.reduce((s, l) => s + l.confirmedQuantity, 0)} servings listed` : 'No leftovers';
    await recordTransition(tx, { entity: ENTITY.EVENT, entityId: id, from: e.status, to: 'CONFIRMED', reason, actorUserId: user.id });
    const event = await tx.event.update({ where: { id }, data: { status: 'CONFIRMED' }, include: EVENT_INCLUDE });
    return { event: await view(tx, event), listingsCreated: listings.length };
  }, TX_OPTIONS);

  if (result.listingsCreated) triggerMatching('event-leftovers');
  return result;
}

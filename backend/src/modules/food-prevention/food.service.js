// Track A, Prevention (M2, Member 2): menu items, daily food records, forecast,
// potential-surplus warning, prevented food and waste ratio.
//
// Anti-inflation rules (team review: "make sure the prevented-food counter cannot be
// inflated by editing records"):
//   - A plan can only be made for today or a future day, never back-dated.
//   - The forecast is snapshotted into forecastShown when the plan is saved.
//   - The planned quantity and forecastShown never change after that.
//   - Actual figures (prepared, sold, wasted) are entered on or after the day, and lock
//     ACTUALS_EDIT_DAYS days later.
//   - Prevention credit is capped (see forecast.js).
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { pkToday } from '../../lib/time.js';
import { weekdayForecast, lookbackDates, surplusWarning, preventedServings, wasteRatio } from './forecast.js';

export const PLAN_AHEAD_DAYS = 7;
export const ACTUALS_EDIT_DAYS = 2;
const DAY_MS = 24 * 3_600_000;

export const toDateOnly = (s) => new Date(`${s}T00:00:00.000Z`);
export const dateLabel = (d) => new Date(d).toISOString().slice(0, 10);

function ownOrgId(user, organisationId) {
  if (user.role === 'ADMIN') {
    if (!organisationId) throw badRequest('Admins must give organisationId');
    return organisationId;
  }
  if (user.role !== 'DONOR' || !user.organisationId) throw forbidden('Only donor businesses keep food records');
  return user.organisationId;
}

function requireRestaurant(user) {
  if (user.role === 'DONOR' && user.donorType !== 'RESTAURANT') {
    throw forbidden('Daily food records and forecasts are for restaurants. Marquees and caterers plan food per event.');
  }
}

/** One record with its derived numbers. */
export function recordView(r) {
  return {
    ...r,
    date: dateLabel(r.date),
    warning: surplusWarning(r.planned, r.forecastShown),
    prevented: preventedServings(r),
    wasteRatio: r.wasted !== null && r.prepared ? wasteRatio(r.wasted, r.prepared) : null,
  };
}

// ---------------------------------------------------------------- menu items

export async function listItems(user, { organisationId } = {}) {
  const orgId = ownOrgId(user, organisationId);
  return prisma.foodItem.findMany({ where: { organisationId: orgId }, include: { category: true }, orderBy: { name: 'asc' } });
}

export async function createItem(user, { name, categoryId }) {
  const orgId = ownOrgId(user);
  const category = await prisma.foodCategory.findUnique({ where: { id: categoryId } });
  if (!category) throw badRequest('Unknown food category');
  const exists = await prisma.foodItem.findUnique({ where: { organisationId_name: { organisationId: orgId, name } } });
  if (exists) throw conflict(`You already have a menu item called "${name}"`);
  return prisma.foodItem.create({ data: { organisationId: orgId, name, categoryId }, include: { category: true } });
}

async function loadOwnItem(user, foodItemId) {
  const item = await prisma.foodItem.findUnique({ where: { id: foodItemId }, include: { category: true } });
  if (!item) throw notFound('Menu item');
  if (user.role !== 'ADMIN' && item.organisationId !== user.organisationId) throw forbidden('This menu item is not yours');
  return item;
}

// ---------------------------------------------------------------- forecast

async function forecastsFor(itemIds, date) {
  const history = await prisma.dailyFoodRecord.findMany({
    where: { foodItemId: { in: itemIds }, date: { in: lookbackDates(date) } },
    select: { foodItemId: true, date: true, sold: true, soldOut: true },
  });
  const byItem = new Map(itemIds.map((id) => [id, []]));
  for (const h of history) byItem.get(h.foodItemId).push(h);
  return new Map(itemIds.map((id) => [id, weekdayForecast(date, byItem.get(id))]));
}

/** Forecast for every menu item on a date (default: today in Pakistan), with that day's record. */
export async function getForecast(user, { date, organisationId } = {}) {
  requireRestaurant(user);
  const orgId = ownOrgId(user, organisationId);
  const day = date ? toDateOnly(date) : pkToday();
  const items = await prisma.foodItem.findMany({ where: { organisationId: orgId }, include: { category: true }, orderBy: { name: 'asc' } });
  const forecasts = await forecastsFor(items.map((i) => i.id), day);
  const records = await prisma.dailyFoodRecord.findMany({ where: { foodItemId: { in: items.map((i) => i.id) }, date: day } });
  const recordByItem = new Map(records.map((r) => [r.foodItemId, r]));
  return {
    date: dateLabel(day),
    weekday: day.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }),
    items: items.map((item) => {
      const f = forecasts.get(item.id);
      const rec = recordByItem.get(item.id);
      return {
        foodItem: { id: item.id, name: item.name, category: item.category.name },
        forecast: f.forecast,
        basedOn: f.basedOn.map((b) => ({ ...b, date: dateLabel(b.date) })),
        note: f.note,
        record: rec ? recordView(rec) : null,
      };
    }),
  };
}

// ---------------------------------------------------------------- daily records

/** Save the plan for an item on a day. The forecast shown is stored with it and never changes. */
export async function savePlan(user, { foodItemId, date, planned }) {
  requireRestaurant(user);
  const item = await loadOwnItem(user, foodItemId);
  const day = toDateOnly(date);
  const today = pkToday();
  if (day < today) throw badRequest('Plans cannot be back-dated: plan for today or a future day');
  if (day > new Date(today.getTime() + PLAN_AHEAD_DAYS * DAY_MS)) throw badRequest(`You can plan at most ${PLAN_AHEAD_DAYS} days ahead`);

  const existing = await prisma.dailyFoodRecord.findUnique({ where: { foodItemId_date: { foodItemId, date: day } } });
  if (existing) {
    throw conflict('A plan for this item and day is already saved. The plan and the forecast shown are locked so the prevented-food counter stays honest.', {
      code: 'PLAN_LOCKED',
    });
  }
  const f = (await forecastsFor([foodItemId], day)).get(foodItemId);
  const record = await prisma.dailyFoodRecord.create({ data: { foodItemId, date: day, planned, forecastShown: f.forecast } });
  return { foodItem: { id: item.id, name: item.name }, forecast: f.forecast, note: f.note, record: recordView(record) };
}

/** Enter what was actually prepared, sold and wasted (on or after the day). */
export async function saveActuals(user, { foodItemId, date, prepared, sold, wasted, wasteReason, soldOut }) {
  requireRestaurant(user);
  await loadOwnItem(user, foodItemId);
  const day = toDateOnly(date);
  const today = pkToday();
  if (day > today) throw badRequest('Actual figures can only be entered on or after the day');
  if (day < new Date(today.getTime() - ACTUALS_EDIT_DAYS * DAY_MS)) {
    throw conflict(`Records older than ${ACTUALS_EDIT_DAYS} days are locked`, { code: 'RECORD_LOCKED' });
  }
  const record = await prisma.dailyFoodRecord.findUnique({ where: { foodItemId_date: { foodItemId, date: day } } });
  if (!record) throw notFound('Plan for this item and day (save the plan first)');

  const next = {
    prepared: prepared ?? record.prepared,
    sold: sold ?? record.sold,
    wasted: wasted ?? record.wasted,
    soldOut: soldOut ?? record.soldOut,
    wasteReason: wasteReason ?? record.wasteReason,
  };
  if (next.prepared === null) throw badRequest('Enter how much was prepared');
  if (next.sold !== null && next.sold > next.prepared) throw badRequest('Sold cannot be more than prepared');
  if (next.sold !== null && wasted === undefined && record.wasted === null) next.wasted = next.prepared - next.sold;
  if (next.wasted !== null && next.wasted > next.prepared) throw badRequest('Wasted cannot be more than prepared');
  if (next.sold !== null && next.wasted !== null && next.sold + next.wasted > next.prepared) {
    throw badRequest('Sold plus wasted cannot be more than prepared');
  }
  if (next.soldOut && next.wasted) throw badRequest('A sold-out item cannot also have waste');

  const updated = await prisma.dailyFoodRecord.update({ where: { id: record.id }, data: next });
  return recordView(updated);
}

export async function listRecords(user, { from, to, foodItemId, organisationId } = {}) {
  requireRestaurant(user);
  const orgId = ownOrgId(user, organisationId);
  const end = to ? toDateOnly(to) : pkToday();
  const start = from ? toDateOnly(from) : new Date(end.getTime() - 13 * DAY_MS);
  const records = await prisma.dailyFoodRecord.findMany({
    where: { foodItem: { organisationId: orgId }, ...(foodItemId ? { foodItemId } : {}), date: { gte: start, lte: end } },
    include: { foodItem: { select: { id: true, name: true } } },
    orderBy: [{ date: 'desc' }, { foodItemId: 'asc' }],
  });
  return records.map(recordView);
}

/**
 * Servings of this business's food that were DONATED and delivered, per Pakistan day the
 * food was prepared. Leftovers that were rescued are not waste, so they are taken off
 * the "wasted" figure before the waste ratio is calculated.
 */
export async function donatedByDay(db, organisationId, { from, to }) {
  const rows = await db.handoverRecord.findMany({
    where: {
      type: 'DELIVERY',
      task: { allocation: { status: 'DELIVERED', listing: { organisationId, preparedAt: { gte: new Date(from.getTime() - 5 * 3_600_000), lt: new Date(to.getTime() + DAY_MS) } } } },
    },
    select: { quantity: true, task: { select: { allocation: { select: { listing: { select: { preparedAt: true } } } } } } },
  });
  const map = new Map();
  for (const r of rows) {
    const key = dateLabel(pkToday(r.task.allocation.listing.preparedAt));
    map.set(key, (map.get(key) || 0) + r.quantity);
  }
  return map;
}

/** Totals for a restaurant: prepared, sold, wasted, donated, waste ratio, prevented, per item and per week. */
export async function summary(user, { days = 28, organisationId } = {}) {
  requireRestaurant(user);
  const orgId = ownOrgId(user, organisationId);
  const end = pkToday();
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  const records = await prisma.dailyFoodRecord.findMany({
    where: { foodItem: { organisationId: orgId }, date: { gte: start, lte: end } },
    include: { foodItem: { select: { id: true, name: true } } },
  });
  return summariseRecords(records, { from: start, to: end, donated: await donatedByDay(prisma, orgId, { from: start, to: end }) });
}

/**
 * wasted = what the restaurant recorded as left over; donated = rescued servings of its
 * food prepared that day; netWasted = wasted - donated (never below 0). The waste ratio
 * uses netWasted, so food that was rescued does not count as waste.
 */
export function summariseRecords(records, { from, to, donated = new Map() }) {
  const totals = { planned: 0, prepared: 0, sold: 0, wasted: 0, prevented: 0, days: 0 };
  const perItem = new Map();
  const perWeek = new Map();
  for (const r of records) {
    const prevented = preventedServings(r);
    const add = (t) => {
      t.planned += r.planned;
      t.prepared += r.prepared ?? 0;
      t.sold += r.sold ?? 0;
      t.wasted += r.wasted ?? 0;
      t.prevented += prevented;
    };
    add(totals);
    const item = perItem.get(r.foodItemId) || { foodItem: r.foodItem, planned: 0, prepared: 0, sold: 0, wasted: 0, prevented: 0 };
    add(item);
    perItem.set(r.foodItemId, item);
    const week = dateLabel(new Date(new Date(r.date).getTime() - ((new Date(r.date).getUTCDay() + 6) % 7) * DAY_MS)); // Monday
    const w = perWeek.get(week) || { weekStarting: week, planned: 0, prepared: 0, sold: 0, wasted: 0, prevented: 0 };
    add(w);
    perWeek.set(week, w);
  }
  const recordDays = new Set(records.map((r) => dateLabel(r.date)));
  totals.days = recordDays.size;
  // Donated servings only count on days that have records (same days as the waste)
  const weekOf = (day) => dateLabel(new Date(toDateOnly(day).getTime() - ((toDateOnly(day).getUTCDay() + 6) % 7) * DAY_MS));
  totals.donated = 0;
  for (const [day, qty] of donated) {
    if (!recordDays.has(day)) continue;
    totals.donated += qty;
    const w = perWeek.get(weekOf(day));
    if (w) w.donated = (w.donated || 0) + qty;
  }
  const withNet = (t) => {
    const netWasted = Math.max(0, t.wasted - (t.donated || 0));
    return { ...t, donated: t.donated || 0, netWasted, wasteRatio: wasteRatio(netWasted, t.prepared) };
  };
  return {
    from: dateLabel(from),
    to: dateLabel(to),
    totals: withNet(totals),
    // Donations cannot be traced to a single menu item, so per-item figures are before donations
    perItem: [...perItem.values()].map((t) => ({ ...t, wasteRatio: wasteRatio(t.wasted, t.prepared) })).sort((a, b) => b.wasted - a.wasted),
    weekly: [...perWeek.values()].map(withNet).sort((a, b) => a.weekStarting.localeCompare(b.weekStarting)),
  };
}

// Member 2 modules: forecast and prevention, events, impact, fairness.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, prisma } from './helpers.js';
import { seed } from '../prisma/seed.js';
import { createApp } from '../src/app.js';
import { pkToday } from '../src/lib/time.js';
import { weekdayForecast, preventedServings, surplusWarning } from '../src/modules/food-prevention/forecast.js';
import { gini } from '../src/modules/fairness/fairness.service.js';

const app = createApp();
const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'Password123' })).body.token;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const DAY = 24 * 3_600_000;
const day = (offset = 0) => new Date(pkToday().getTime() + offset * DAY).toISOString().slice(0, 10);

let restaurant, marquee, admin, ngo, volunteer;
beforeAll(async () => {
  await resetDb();
  await seed(prisma, { activity: true }); // 4 weeks of food records, events and past rescues
  [restaurant, marquee, admin, ngo, volunteer] = await Promise.all(
    ['restaurant@foodrescue.test', 'events@foodrescue.test', 'admin@foodrescue.test', 'ngo@foodrescue.test', 'volunteer@foodrescue.test'].map(login),
  );
});
afterAll(() => prisma.$disconnect());

describe('forecast maths (pure)', () => {
  const date = new Date('2026-11-27T00:00:00Z');
  const wk = (n) => new Date(date.getTime() - n * 7 * DAY);

  it('weights the newest week most: (80x1 + 90x2 + 100x3 + 110x4) / 10 = 100', () => {
    const history = [
      { date: wk(4), sold: 80, soldOut: false },
      { date: wk(3), sold: 90, soldOut: false },
      { date: wk(2), sold: 100, soldOut: false },
      { date: wk(1), sold: 110, soldOut: false },
    ];
    expect(weekdayForecast(date, history).forecast).toBe(100);
  });

  it('leaves out sold-out days when enough other weeks remain, and needs 2 weeks of history', () => {
    const history = [
      { date: wk(1), sold: 40, soldOut: true },
      { date: wk(2), sold: 100, soldOut: false },
      { date: wk(3), sold: 100, soldOut: false },
    ];
    const f = weekdayForecast(date, history);
    expect(f.forecast).toBe(100);
    expect(f.note).toMatch(/sold-out/);
    expect(weekdayForecast(date, [{ date: wk(1), sold: 50, soldOut: false }]).forecast).toBeNull();
  });

  it('prevented = min(planned - prepared, planned - forecast shown), capped, never without a forecast', () => {
    expect(preventedServings({ planned: 130, prepared: 110, forecastShown: 100 })).toBe(20);
    expect(preventedServings({ planned: 130, prepared: 90, forecastShown: 100 })).toBe(30);
    expect(preventedServings({ planned: 1000, prepared: 100, forecastShown: 100 })).toBe(50); // inflated plan: capped
    expect(preventedServings({ planned: 130, prepared: 90, forecastShown: null })).toBe(0);
    expect(surplusWarning(130, 100)).toMatchObject({ potentialSurplus: 30, percentAboveForecast: 30, level: 'HIGH' });
    expect(surplusWarning(90, 100)).toBeNull();
  });

  it('gini is 0 for equal shares and near 1 when one NGO gets everything', () => {
    expect(gini([10, 10, 10])).toBe(0);
    expect(gini([0, 0, 0, 100])).toBe(0.75);
  });
});

describe('forecast and prevention API (/api/food)', () => {
  let item;
  it('gives a forecast for each menu item from 4 weeks of history', async () => {
    const res = await request(app).get('/api/food/forecast').set(auth(restaurant));
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(day(0));
    item = res.body.items.find((i) => !i.record && i.forecast !== null);
    expect(item).toBeTruthy();
    expect(item.basedOn.length).toBeGreaterThanOrEqual(2);
  });

  it('warns about potential surplus and locks the plan and forecast shown', async () => {
    const plan = await request(app).post('/api/food/records/plan').set(auth(restaurant)).send({ foodItemId: item.foodItem.id, date: day(0), planned: item.forecast + 30 });
    expect(plan.status).toBe(201);
    expect(plan.body.record.forecastShown).toBe(item.forecast);
    expect(plan.body.record.warning.potentialSurplus).toBe(30);

    const again = await request(app).post('/api/food/records/plan').set(auth(restaurant)).send({ foodItemId: item.foodItem.id, date: day(0), planned: 999 });
    expect(again.status).toBe(409);
    expect(again.body.error.details.code).toBe('PLAN_LOCKED');
  });

  it('refuses back-dated plans', async () => {
    const res = await request(app).post('/api/food/records/plan').set(auth(restaurant)).send({ foodItemId: item.foodItem.id, date: day(-3), planned: 50 });
    expect(res.status).toBe(400);
  });

  it('records actual figures and counts prevented food', async () => {
    const res = await request(app).patch('/api/food/records/actuals').set(auth(restaurant)).send({ foodItemId: item.foodItem.id, date: day(0), prepared: item.forecast, sold: item.forecast - 5 });
    expect(res.status).toBe(200);
    expect(res.body.record.prevented).toBe(Math.min(30, Math.ceil(item.forecast / 2)));
    expect(res.body.record.wasted).toBe(5);

    const bad = await request(app).patch('/api/food/records/actuals').set(auth(restaurant)).send({ foodItemId: item.foodItem.id, date: day(0), sold: item.forecast + 50 });
    expect(bad.status).toBe(400);
  });

  it('summarises prepared, wasted, waste ratio and prevented', async () => {
    const res = await request(app).get('/api/food/summary?days=28').set(auth(restaurant));
    expect(res.status).toBe(200);
    expect(res.body.totals.prepared).toBeGreaterThan(0);
    expect(res.body.totals.wasteRatio).toBeGreaterThan(0);
    expect(res.body.totals.prevented).toBeGreaterThan(0);
    expect(res.body.weekly.length).toBeGreaterThanOrEqual(4);
    expect(res.body.totals).toHaveProperty('donated');
    expect(res.body.totals.netWasted).toBeLessThanOrEqual(res.body.totals.wasted);
  });

  it('is for restaurants only (marquees plan per event)', async () => {
    expect((await request(app).get('/api/food/forecast').set(auth(marquee))).status).toBe(403);
    expect((await request(app).get('/api/food/forecast').set(auth(ngo))).status).toBe(403);
  });
});

describe('events API (/api/events)', () => {
  let items;
  let eventId;
  beforeAll(async () => {
    items = (await request(app).get('/api/food/items').set(auth(marquee))).body.items;
  });

  it('plans an event and estimates needed servings', async () => {
    const res = await request(app)
      .post('/api/events')
      .set(auth(marquee))
      .send({
        name: 'Test Walima',
        date: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        venue: 'Serena Hotel, Hall B',
        expectedGuests: 200,
        servingsPerGuest: 1.1,
        plans: [{ foodItemId: items[0].id, plannedServings: 150 }, { foodItemId: items[1].id, plannedServings: 150 }],
      });
    expect(res.status).toBe(201);
    eventId = res.body.event.id;
    expect(res.body.event.estimate).toMatchObject({ neededServings: 220, plannedServings: 300, overPlanned: 80 });
    expect(res.body.event.estimate.warning).toMatch(/80 servings/);
  });

  it('completes the event and turns confirmed leftovers into listings', async () => {
    expect((await request(app).post(`/api/events/${eventId}/complete`).set(auth(marquee))).status).toBe(200);
    const res = await request(app)
      .post(`/api/events/${eventId}/leftovers`)
      .set(auth(marquee))
      .send({ safetyConfirmed: true, leftovers: [{ categoryId: items[0].categoryId, description: 'Chicken biryani, covered trays', quantity: 60 }] });
    expect(res.status).toBe(201);
    expect(res.body.listingsCreated).toBe(1);
    expect(res.body.event.status).toBe('CONFIRMED');
    const listing = await prisma.surplusListing.findFirstOrThrow({ where: { eventId } });
    expect(listing).toMatchObject({ sourceType: 'EVENT', confirmedQuantity: 60, status: 'OPEN' });
    expect(listing.collectionDeadline <= listing.safeUntil).toBe(true);

    const twice = await request(app).post(`/api/events/${eventId}/leftovers`).set(auth(marquee)).send({ leftovers: [] });
    expect(twice.status).toBe(409);
  });

  it('marquees earn Prevented: plan saved before the event, cooked amount entered after', async () => {
    const created = await request(app)
      .post('/api/events')
      .set(auth(marquee))
      .send({
        name: 'Prevention Walima',
        date: new Date(Date.now() + 2 * 60_000).toISOString(),
        venue: 'Serena Hotel, Hall C',
        expectedGuests: 300,
        servingsPerGuest: 1,
        plans: [{ foodItemId: items[2].id, plannedServings: 250 }, { foodItemId: items[3].id, plannedServings: 150 }],
      });
    expect(created.status).toBe(201);
    const ev = created.body.event;
    expect(ev.prevention).toMatchObject({ recorded: true, estimateShown: 300, plannedAtEstimate: 400, prepared: null, prevented: 0 });

    // The plan is locked to its date for the counter
    const moved = await request(app).patch(`/api/events/${ev.id}`).set(auth(marquee)).send({ date: new Date(Date.now() + 3 * DAY).toISOString() });
    expect(moved.status).toBe(409);

    // The event happens (moved just into the past for the test), then the marquee enters what it cooked
    await prisma.event.update({ where: { id: ev.id }, data: { date: new Date(Date.now() - 60_000) } });
    const done = await request(app)
      .post(`/api/events/${ev.id}/complete`)
      .set(auth(marquee))
      .send({ prepared: [{ foodItemId: items[2].id, preparedServings: 190 }, { foodItemId: items[3].id, preparedServings: 115 }] });
    expect(done.status).toBe(200);
    // dish 1: planned 250, estimate 188, cooked 190 -> min(60, 62) = 60; dish 2: planned 150, estimate 112, cooked 115 -> min(35, 38) = 35
    expect(done.body.event.prevention).toMatchObject({ prepared: 305, prevented: 95 });

    // Leftovers cannot be more than what was cooked
    const tooMuch = await request(app)
      .post(`/api/events/${ev.id}/leftovers`)
      .set(auth(marquee))
      .send({ safetyConfirmed: true, leftovers: [{ categoryId: items[2].categoryId, description: 'Too many leftovers', quantity: 400 }] });
    expect(tooMuch.status).toBe(400);

    const impact = await request(app).get('/api/impact/summary?days=7').set(auth(admin));
    expect(impact.body.totals.preventedBreakdown.marquees).toBeGreaterThanOrEqual(95);
  });

  it('cannot complete a future event, and restaurants cannot plan events', async () => {
    const future = await request(app)
      .post('/api/events')
      .set(auth(marquee))
      .send({ name: 'Future Mehndi', date: new Date(Date.now() + 3 * DAY).toISOString(), venue: 'Hall A', expectedGuests: 100 });
    expect(future.status).toBe(201);
    expect((await request(app).post(`/api/events/${future.body.event.id}/complete`).set(auth(marquee))).status).toBe(409);
    expect((await request(app).get('/api/events').set(auth(restaurant))).status).toBe(403);
  });
});

describe('impact (/api/impact) and fairness (/api/fairness)', () => {
  it('reports Prevented, Rescued and Lost separately, with a daily trend', async () => {
    const res = await request(app).get('/api/impact/summary?days=30').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.totals.rescued).toBeGreaterThan(0);
    expect(res.body.totals.lost).toBeGreaterThan(0);
    expect(res.body.totals.lostBreakdown).toHaveProperty('expiredUnclaimed');
    expect(res.body.totals).toHaveProperty('shortfallAtPickup');
    expect(res.body.trend).toHaveLength(31);
    expect(res.body.topDonors.length).toBeGreaterThan(0);
  });

  it('gives an NGO its own numbers with scope=mine', async () => {
    const res = await request(app).get('/api/impact/summary?scope=mine&interval=week').set(auth(ngo));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('ngo');
    expect(res.body.totals.prevented).toBe(0);
  });

  it('shows the fairness ledger to admins and NGOs, least-served first', async () => {
    const res = await request(app).get('/api/fairness').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.ngos.length).toBeGreaterThan(5);
    expect(res.body.summary.gini).toBeGreaterThanOrEqual(0);
    expect(res.body.summary.gini).toBeLessThanOrEqual(1);
    expect(res.body.ngos[0].received).toBeLessThanOrEqual(res.body.ngos.at(-1).received);
    expect((await request(app).get('/api/fairness').set(auth(ngo))).status).toBe(200);
    expect((await request(app).get('/api/fairness').set(auth(volunteer))).status).toBe(403);
  });
});

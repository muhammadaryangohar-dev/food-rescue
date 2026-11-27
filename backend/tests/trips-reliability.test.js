// Extra features: near-expiry alert, combined pickup trip for pooled food, reliability
// score. Fixes: NGO daily capacity across requests, Pakistan time for licence expiry.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, makeRequest, prisma, user, inHours } from './helpers.js';
import { createApp } from '../src/app.js';
import { createListing } from '../src/modules/listings/listing.service.js';
import { createRequest } from '../src/modules/matching/request.service.js';
import { createAllocation, acceptAllocation, rejectAllocation } from '../src/modules/allocations/allocation.service.js';
import { runSweep } from '../src/modules/allocations/sweep.service.js';
import { simulateExpiry } from '../src/modules/notifications-admin/admin.service.js';
import { licenceExpired } from '../src/lib/access.js';
import { pkToday } from '../src/lib/time.js';
import { haversineKm } from '../src/lib/haversine.js';

const app = createApp();
const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'Password123' })).body.token;
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const listingFor = async (email, { quantity = 40, safeHours = 4, deadlineHours = 3, categoryId = 1 } = {}) =>
  createListing(await user(email), {
    categoryId, description: 'Test food', confirmedQuantity: quantity,
    preparedAt: new Date(Date.now() - 30 * 60_000), safeUntil: inHours(safeHours), collectionDeadline: inHours(deadlineHours), safetyConfirmed: true,
  });

const notices = (email, type) => prisma.notification.count({ where: { type, user: { email } } });

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

describe('fix: NGO daily capacity counts all requests for the same day', () => {
  // Noon tomorrow in Pakistan, and noon the day after
  const pkNoon = (days) => new Date(pkToday().getTime() + days * 86_400_000 + 7 * 3_600_000);

  it('requests for one Pakistan day cannot add up to more than the daily capacity', async () => {
    const ngo = await user('ngo2@foodrescue.test'); // Robin Hood Army, capacity 300
    await createRequest(ngo, { categoryId: 1, requestedQuantity: 200, requiredBy: pkNoon(1) });
    await expect(createRequest(ngo, { categoryId: 1, requestedQuantity: 150, requiredBy: pkNoon(1) })).rejects.toMatchObject({ status: 400, details: { code: 'DAILY_CAPACITY', remaining: 100 } });
    await expect(createRequest(ngo, { categoryId: 1, requestedQuantity: 100, requiredBy: pkNoon(1) })).resolves.toBeTruthy();
    // A different day has its own capacity
    await expect(createRequest(ngo, { categoryId: 1, requestedQuantity: 250, requiredBy: pkNoon(2) })).resolves.toBeTruthy();
  });

  it('raising a request above what is left for that day is refused too', async () => {
    const ngo = await user('ngo2@foodrescue.test');
    const r = await prisma.nGORequest.findFirst({ where: { ngoId: ngo.organisationId, requestedQuantity: 250 } });
    const res = await request(app).patch(`/api/requests/${r.id}`).set(auth(await login('ngo2@foodrescue.test'))).send({ requestedQuantity: 301 });
    expect(res.status).toBe(400);
    await prisma.nGORequest.updateMany({ where: { ngoId: ngo.organisationId }, data: { status: 'CANCELLED' } });
  });
});

describe('fix: licence expiry uses Pakistan time', () => {
  it('a licence expiring on a date is valid until midnight in Pakistan (19:00 UTC)', () => {
    const org = { licenceExpiresOn: new Date('2027-06-30T00:00:00Z') };
    expect(licenceExpired(org, new Date('2027-06-30T18:30:00Z'))).toBe(false); // 23:30 in Islamabad
    expect(licenceExpired(org, new Date('2027-06-30T19:00:00Z'))).toBe(true); // 00:00 on 1 July in Islamabad
  });
});

describe('near-expiry alert', () => {
  it('alerts nearby NGOs once when unallocated food is close to its safe-until time', async () => {
    const listing = await listingFor('restaurant@foodrescue.test', { quantity: 30, safeHours: 1.5, deadlineHours: 1 }); // Savour Foods, Blue Area
    expect(listing.nearExpiry).toBe(true);

    const before = await notices('ngo@foodrescue.test', 'NEAR_EXPIRY'); // Rizq, F-8: a few km away
    const first = await runSweep();
    expect(first.nearExpiryAlerts).toBeGreaterThanOrEqual(1);
    expect(await notices('ngo@foodrescue.test', 'NEAR_EXPIRY')).toBe(before + 1);
    expect((await prisma.surplusListing.findUnique({ where: { id: listing.id } })).nearExpiryAlertedAt).not.toBeNull();

    // Only once per listing
    const second = await runSweep();
    expect(second.nearExpiryAlerts).toBe(0);
    expect(await notices('ngo@foodrescue.test', 'NEAR_EXPIRY')).toBe(before + 1);
  });

  it('accepting near-expiry food sends volunteers an URGENT pickup notice, and urgent tasks are listed first', async () => {
    const urgentListing = await listingFor('restaurant@foodrescue.test', { quantity: 20, safeHours: 1.5, deadlineHours: 1 });
    const r = await makeRequest({ quantity: 20 });
    const a = await createAllocation({ listingId: urgentListing.id, requestId: r.id, quantity: 20 });
    const before = await notices('volunteer@foodrescue.test', 'URGENT_PICKUP');
    await acceptAllocation(await user('ngo@foodrescue.test'), a.id);
    expect(await notices('volunteer@foodrescue.test', 'URGENT_PICKUP')).toBe(before + 1);

    const res = await request(app).get('/api/tasks/available').set(auth(await login('volunteer@foodrescue.test')));
    expect(res.body.tasks[0].nearExpiry).toBe(true);
    const hours = res.body.tasks.map((t) => t.hoursLeft);
    expect(hours).toEqual([...hours].sort((x, y) => x - y));
  });
});

describe('combined pickup trip for pooled food', () => {
  let trip;
  it('two donors filling one request become one trip with ordered stops', async () => {
    const savour = await listingFor('restaurant@foodrescue.test', { quantity: 30 }); // Blue Area
    const kabul = await listingFor('kabul-restaurant@foodrescue.test', { quantity: 30 }); // F-7
    const r = await makeRequest({ quantity: 50, email: 'ngo2@foodrescue.test', requiredHours: 4 }); // Robin Hood Army, F-6
    const ngo2 = await user('ngo2@foodrescue.test');
    for (const [l, q] of [[savour, 30], [kabul, 20]]) {
      const a = await createAllocation({ listingId: l.id, requestId: r.id, quantity: q });
      await acceptAllocation(ngo2, a.id);
    }
    const res = await request(app).get('/api/tasks/trips').set(auth(await login('volunteer@foodrescue.test')));
    expect(res.status).toBe(200);
    trip = res.body.trips.find((t) => t.requestId === r.id);
    expect(trip.totalServings).toBe(50);
    expect(trip.stops.map((s) => s.type)).toEqual(['PICKUP', 'PICKUP', 'DROPOFF']);
    expect(trip.stops[2].ngoName).toBe('Robin Hood Army Islamabad');
    // The route starts at the pickup farther from the NGO, so it moves towards the drop-off
    const ngoOrg = await prisma.organisation.findUnique({ where: { id: ngo2.organisationId } });
    const dist = (l) => haversineKm(l.latitude, l.longitude, ngoOrg.latitude, ngoOrg.longitude);
    const farther = dist(savour) >= dist(kabul) ? 'Savour Foods' : 'Kabul Restaurant';
    expect(trip.stops[0].donorName).toBe(farther);
    expect(trip.totalKm).toBeGreaterThan(0);
    expect(trip.stops[0].address).toBeUndefined(); // not claimed yet: area only
  });

  it('claiming the trip claims every task at once; a second volunteer gets 409', async () => {
    const res = await request(app).post(`/api/tasks/trips/${trip.requestId}/claim`).set(auth(await login('volunteer@foodrescue.test'))).send({ taskIds: trip.taskIds });
    expect(res.status).toBe(200);
    expect(res.body.trip.stops.filter((s) => s.type === 'PICKUP').every((s) => s.task.status === 'CLAIMED')).toBe(true);
    expect(res.body.trip.stops[0].task.allocation.listing.address).toBeTruthy(); // claimed: exact address visible
    const tasks = await prisma.rescueTask.findMany({ where: { id: { in: trip.taskIds } } });
    // The later stop gets extra time for travelling to it
    const [first, second] = trip.taskIds.map((id) => tasks.find((t) => t.id === id));
    expect(second.claimDeadline.getTime()).toBeGreaterThanOrEqual(first.claimDeadline.getTime());

    const again = await request(app).post(`/api/tasks/trips/${trip.requestId}/claim`).set(auth(await login('volunteer2@foodrescue.test'))).send({ taskIds: trip.taskIds });
    expect(again.status).toBe(409);

    const mine = await request(app).get('/api/tasks/trips/mine').set(auth(await login('volunteer@foodrescue.test')));
    expect(mine.body.trips.find((t) => t.requestId === trip.requestId).stops).toHaveLength(3);
  });

  it('all or nothing: if one task was taken meanwhile, nothing is claimed', async () => {
    const a1 = await listingFor('restaurant@foodrescue.test', { quantity: 20 });
    const a2 = await listingFor('kabul-restaurant@foodrescue.test', { quantity: 20 });
    const r = await makeRequest({ quantity: 40, requiredHours: 4 });
    const ngo = await user('ngo@foodrescue.test');
    const taskIds = [];
    for (const l of [a1, a2]) {
      const a = await createAllocation({ listingId: l.id, requestId: r.id, quantity: 20 });
      taskIds.push((await acceptAllocation(ngo, a.id)).task.id);
    }
    const v2 = await login('volunteer2@foodrescue.test');
    expect((await request(app).post(`/api/tasks/${taskIds[1]}/claim`).set(auth(v2))).status).toBe(200);

    const res = await request(app).post(`/api/tasks/trips/${r.id}/claim`).set(auth(await login('volunteer@foodrescue.test'))).send({ taskIds });
    expect(res.status).toBe(409);
    expect(res.body.error.details.unavailable).toEqual([taskIds[1]]);
    expect((await prisma.rescueTask.findUnique({ where: { id: taskIds[0] } })).status).toBe('OPEN'); // rolled back
  });
});

describe('reliability score', () => {
  it('NGO score: accepted counts fully, rejected half, ignored offers zero', async () => {
    // Use an NGO with no history in this file: Edhi Foundation
    const edhi = await user('edhi-foundation@foodrescue.test');
    const mk = async () => {
      const l = await listingFor('restaurant@foodrescue.test', { quantity: 10 });
      const r = await createRequest(edhi, { categoryId: 1, requestedQuantity: 10, requiredBy: inHours(5) });
      return createAllocation({ listingId: l.id, requestId: r.id, quantity: 10 });
    };
    await acceptAllocation(edhi, (await mk()).id);
    await acceptAllocation(edhi, (await mk()).id);
    await rejectAllocation(edhi, (await mk()).id, { reason: 'No space' });
    await simulateExpiry(await user('admin@foodrescue.test'), { allocationId: (await mk()).id });

    const res = await request(app).get('/api/reliability/me').set(auth(await login('edhi-foundation@foodrescue.test')));
    expect(res.status).toBe(200);
    expect(res.body.reliability.offers).toEqual({ accepted: 2, rejected: 1, unanswered: 1 });
    expect(res.body.reliability.score).toBe(63); // 100 x (2 + 0.5) / 4 = 62.5
    expect(res.body.reliability.level).toBe('FAIR');
  });

  it('too little history gives NEW instead of a score; admins see everyone, lowest first', async () => {
    const res = await request(app).get('/api/reliability/me').set(auth(await login('volunteer2@foodrescue.test')));
    expect(res.body.reliability.score).toBeNull();
    expect(res.body.reliability.level).toBe('NEW');

    const admin = await login('admin@foodrescue.test');
    const ngos = await request(app).get('/api/admin/reliability').query({ role: 'NGO' }).set(auth(admin));
    expect(ngos.status).toBe(200);
    const scored = ngos.body.scores.filter((s) => s.score !== null).map((s) => s.score);
    expect(scored).toEqual([...scored].sort((x, y) => x - y));
    expect(ngos.body.scores.at(-1).level).toBe('NEW');
    expect((await request(app).get('/api/admin/reliability').query({ role: 'VOLUNTEER' }).set(auth(admin))).status).toBe(200);

    // Donors have no reliability score; non-admins cannot see the admin list
    expect((await request(app).get('/api/reliability/me').set(auth(await login('restaurant@foodrescue.test')))).status).toBe(403);
    expect((await request(app).get('/api/admin/reliability').query({ role: 'NGO' }).set(auth(await login('ngo@foodrescue.test')))).status).toBe(403);
  });
});

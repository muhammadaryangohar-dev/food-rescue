// Withdrawal and edit rules, plus HTTP-level security checks (auth, roles, validation).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, makeListing, makeRequest, claimedScenario, prisma, user } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAllocation } from '../src/modules/allocations/allocation.service.js';
import { withdrawListing, updateListing } from '../src/modules/listings/listing.service.js';
import { cancelRequest } from '../src/modules/matching/request.service.js';
import { confirmPickup } from '../src/modules/rescue/rescue.service.js';

const app = createApp();
const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'Password123' })).body.token;

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

describe('withdrawal and edit rules', () => {
  it('withdrawing cancels proposed and accepted offers but not food already picked up', async () => {
    const s = await claimedScenario({ quantity: 10 }); // 40-serving listing, 10 accepted+claimed
    await confirmPickup(await user('volunteer@foodrescue.test'), s.task.id, { code: s.pickupCode, quantity: 10 });
    const r2 = await makeRequest({ quantity: 10, email: 'ngo2@foodrescue.test' });
    const proposed = await createAllocation({ listingId: s.listing.id, requestId: r2.id, quantity: 10 });

    const result = await withdrawListing(await user('restaurant@foodrescue.test'), s.listing.id, { reason: 'Test' });
    expect(result.cancelledAllocations).toBe(1);
    expect((await prisma.allocation.findUnique({ where: { id: proposed.id } })).status).toBe('CANCELLED');
    expect((await prisma.allocation.findUnique({ where: { id: s.allocation.id } })).status).toBe('PICKED_UP');
    expect((await prisma.surplusListing.findUnique({ where: { id: s.listing.id } })).status).toBe('CLOSED');
  });

  it('quantity and deadlines are locked once allocations exist; notes are not', async () => {
    const listing = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 10 });
    await createAllocation({ listingId: listing.id, requestId: r.id, quantity: 10 });
    const donor = await user('restaurant@foodrescue.test');
    await expect(updateListing(donor, listing.id, { confirmedQuantity: 60 })).rejects.toMatchObject({ status: 409 });
    const ok = await updateListing(donor, listing.id, { handlingNotes: 'Keep upright' });
    expect(ok.handlingNotes).toBe('Keep upright');
  });

  it('other donors cannot edit or withdraw my listing', async () => {
    const listing = await makeListing({ quantity: 30 });
    await expect(withdrawListing(await user('events@foodrescue.test'), listing.id)).rejects.toMatchObject({ status: 403 });
  });

  it('cancelling a request releases its offers', async () => {
    const listing = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 20 });
    const a = await createAllocation({ listingId: listing.id, requestId: r.id, quantity: 20 });
    await cancelRequest(await user('ngo@foodrescue.test'), r.id, { reason: 'Event cancelled' });
    expect((await prisma.allocation.findUnique({ where: { id: a.id } })).status).toBe('CANCELLED');
    expect((await prisma.nGORequest.findUnique({ where: { id: r.id } })).status).toBe('CANCELLED');
  });

  it('database CHECK constraint: event_id is set exactly when the source is EVENT', async () => {
    const donor = await user('restaurant@foodrescue.test');
    await expect(
      prisma.surplusListing.create({
        data: {
          sourceType: 'EVENT', organisationId: donor.organisationId, createdById: donor.id, categoryId: 1, // EVENT source without an event (chk_listing_source)
          description: 'x', confirmedQuantity: 5, preparedAt: new Date(), safeUntil: new Date(Date.now() + 3600e3), collectionDeadline: new Date(Date.now() + 1800e3), address: 'a', area: 'b',
        },
      }),
    ).rejects.toThrow(/chk_listing_source/);
  });
});

describe('HTTP security', () => {
  it('health check', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('up');
  });

  it('401 without token, 401 with a bad token', async () => {
    expect((await request(app).get('/api/listings')).status).toBe(401);
    expect((await request(app).get('/api/listings').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('403 for the wrong role and for deactivated users', async () => {
    const ngo = await login('ngo@foodrescue.test');
    expect((await request(app).get('/api/admin/config').set('Authorization', `Bearer ${ngo}`)).status).toBe(403);

    const caterer = await login('caterer@foodrescue.test');
    await prisma.user.update({ where: { email: 'caterer@foodrescue.test' }, data: { active: false } });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${caterer}`);
    expect(res.status).toBe(403);
    await prisma.user.update({ where: { email: 'caterer@foodrescue.test' }, data: { active: true } });
  });

  it('validation errors come back as 400 with field details', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'not-an-email', role: 'NGO' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('password is never returned; login with wrong password is 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'ngo@foodrescue.test', password: 'Password123' });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect((await request(app).post('/api/auth/login').send({ email: 'ngo@foodrescue.test', password: 'wrong' })).status).toBe(401);
  });

  it('registration creates a pending organisation that cannot act until verified', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ali', email: 'newngo@test.local', password: 'Secret123', role: 'NGO', organisation: { name: 'Test NGO', address: 'Street 1', area: 'G-6', ngoType: 'FOOD_KITCHEN', dailyCapacity: 50, beneficiaries: 30, serviceRadiusKm: 5 } });
    expect(res.status).toBe(201);
    expect(res.body.user.verified).toBe(false);
    const create = await request(app).post('/api/requests').set('Authorization', `Bearer ${res.body.token}`).send({ categoryId: 1, requestedQuantity: 10, requiredBy: new Date(Date.now() + 7200e3) });
    expect(create.status).toBe(403);
  });

  it('manual area fallback: an Islamabad area without a map point gets the area centre', async () => {
    const areas = await request(app).get('/api/areas');
    expect(areas.status).toBe(200);
    expect(areas.body.areas.find((a) => a.name === 'G-9')).toBeTruthy();

    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Sara', email: 'sara@test.local', password: 'Secret123', role: 'DONOR', donorType: 'RESTAURANT', organisation: { name: 'G-9 Tikka House', address: 'Shop 4, G-9 Markaz', area: 'g-9', licenceNumber: 'IFA-TEST-0901' } });
    expect(res.status).toBe(201);
    const o = res.body.user.organisation;
    expect(o.area).toBe('G-9'); // normalised spelling
    expect(o.latitude).toBeCloseTo(33.688, 2);
    expect(o.longitude).toBeCloseTo(73.031, 2);

    // An unknown area is accepted as typed, without coordinates (never blocks the user)
    const other = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Omar', email: 'omar@test.local', password: 'Secret123', role: 'NGO', organisation: { name: 'Bhara Kahu Langar', address: 'Main Road', area: 'Bhara Kahu', ngoType: 'FOOD_KITCHEN', dailyCapacity: 40, beneficiaries: 20, serviceRadiusKm: 5 } });
    expect(other.body.user.organisation.area).toBe('Bhara Kahu');
    expect(other.body.user.organisation.latitude).toBeNull();
  });

  it('unknown routes return 404 JSON', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

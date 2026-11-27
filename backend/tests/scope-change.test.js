// Scope Change Note (27 Nov 2026): only licensed restaurants and marquees/caterers donate;
// households use the opt-in public NGO directory; listings always belong to a business;
// NGO type and beneficiaries; a declined offer is never re-offered.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, makeListing, makeRequest, prisma, user, inHours } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAllocation, rejectAllocation } from '../src/modules/allocations/allocation.service.js';
import { simulateExpiry } from '../src/modules/notifications-admin/admin.service.js';
import { createListing } from '../src/modules/listings/listing.service.js';
import { NGOS } from '../prisma/seed-data/islamabad.js';

// Seeded NGOs that should appear in the directory: verified and opted in
// [slug, name, area, address, status, capacity, radius, ngoType, beneficiaries, showInDirectory]
const LISTED_NGOS = NGOS.filter((n) => n[4] === 'VERIFIED' && n[9]);

const app = createApp();
const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'Password123' })).body.token;
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const daysFromNow = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

const business = (over = {}) => ({
  name: 'Owner',
  email: `owner${Math.random().toString(36).slice(2, 8)}@test.local`,
  password: 'Secret123',
  role: 'DONOR',
  donorType: 'MARQUEE_CATERER',
  organisation: { name: 'Test Marquee', address: 'Park Road', area: 'Park Road (Chak Shahzad)', licenceNumber: `IFA-T-${Math.floor(Math.random() * 1e6)}`, licenceExpiresOn: daysFromNow(200) },
  ...over,
});

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

describe('only licensed businesses can donate', () => {
  it('households cannot register as donors and are pointed to the NGO directory', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ali', email: 'home@test.local', password: 'Secret123', role: 'DONOR', donorType: 'HOUSEHOLD', organisation: { name: 'My home', address: 'House 1', area: 'G-9' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toMatch(/NGO directory/);
  });

  it('a marquee / caterer registers with its food licence and starts PENDING', async () => {
    const res = await request(app).post('/api/auth/register').send(business());
    expect(res.status).toBe(201);
    expect(res.body.user.verified).toBe(false);
    expect(res.body.user.organisation.licenceAuthority).toBe('Islamabad Food Authority'); // default
    expect(res.body.user.organisation.type).toBe('MARQUEE_CATERER');
  });

  it('a licence number is required, must not be expired and must be unique', async () => {
    const noLicence = business();
    delete noLicence.organisation.licenceNumber;
    expect((await request(app).post('/api/auth/register').send(noLicence)).status).toBe(400);

    const expired = business();
    expired.organisation.licenceExpiresOn = daysFromNow(-1);
    expect((await request(app).post('/api/auth/register').send(expired)).status).toBe(400);

    const first = business();
    first.organisation.licenceNumber = 'IFA-DUP-1';
    expect((await request(app).post('/api/auth/register').send(first)).status).toBe(201);
    const second = business();
    second.organisation.licenceNumber = 'IFA-DUP-1';
    expect((await request(app).post('/api/auth/register').send(second)).status).toBe(409);
  });

  it('database CHECK: a donor business row without a licence is refused', async () => {
    await expect(prisma.organisation.create({ data: { name: 'No licence', type: 'RESTAURANT', address: 'x', area: 'F-7' } })).rejects.toThrow(/chk_donor_org_licence/);
  });

  it('the admin cannot approve an expired licence, but can approve a valid one', async () => {
    const admin = await login('admin@foodrescue.test');
    const expired = await prisma.organisation.findFirst({ where: { name: 'Cafe Aylanto' } });
    const valid = await prisma.organisation.findFirst({ where: { name: 'Asian Wok' } });

    const list = await request(app).get('/api/admin/verifications').set(auth(admin));
    expect(list.body.organisations.find((o) => o.id === expired.id).licenceExpired).toBe(true);
    expect(list.body.households).toBeUndefined();

    const refused = await request(app).patch(`/api/admin/organisations/${expired.id}/verification`).set(auth(admin)).send({ status: 'VERIFIED' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/expired/);

    const ok = await request(app).patch(`/api/admin/organisations/${valid.id}/verification`).set(auth(admin)).send({ status: 'VERIFIED' });
    expect(ok.status).toBe(200);
  });

  it('when a verified donor licence expires, it can no longer list food or receive allocations', async () => {
    const listing = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 10 });
    const donor = await user('restaurant@foodrescue.test');
    await prisma.organisation.update({ where: { id: donor.organisationId }, data: { licenceExpiresOn: new Date(Date.now() - 2 * 86_400_000) } });

    const token = await login('restaurant@foodrescue.test');
    const me = await request(app).get('/api/auth/me').set(auth(token));
    expect(me.body.user.verified).toBe(false);
    const create = await request(app).post('/api/listings').set(auth(token)).send({});
    expect(create.status).toBe(403);
    await expect(createAllocation({ listingId: listing.id, requestId: r.id, quantity: 10 })).rejects.toMatchObject({ status: 409 });

    await prisma.organisation.update({ where: { id: donor.organisationId }, data: { licenceExpiresOn: new Date(Date.now() + 300 * 86_400_000) } });
  });

  it('changing the licence on the profile sends the business back for verification', async () => {
    const token = await login('caterer@foodrescue.test');
    const res = await request(app).patch('/api/auth/me').set(auth(token)).send({ organisation: { licenceNumber: 'IFA-RENEWED-77' } });
    expect(res.status).toBe(200);
    expect(res.body.user.organisation.verificationStatus).toBe('PENDING');
    expect(res.body.user.verified).toBe(false);

    // A donor business cannot set NGO-only fields
    const bad = await request(app).patch('/api/auth/me').set(auth(token)).send({ organisation: { dailyCapacity: 50 } });
    expect(bad.status).toBe(400);
  });
});

describe('NGO type and beneficiaries', () => {
  const ngo = (org) => ({ name: 'Nadia', email: `n${Math.random().toString(36).slice(2, 8)}@test.local`, password: 'Secret123', role: 'NGO', organisation: { name: 'Test Home', address: 'Street 5, G-6/2', area: 'G-6', ngoType: 'ORPHANAGE', dailyCapacity: 90, beneficiaries: 40, serviceRadiusKm: 5, ...org } });

  it('an NGO needs a type and the number of people it serves', async () => {
    expect((await request(app).post('/api/auth/register').send(ngo({ ngoType: undefined }))).status).toBe(400);
    expect((await request(app).post('/api/auth/register').send(ngo({ beneficiaries: undefined }))).status).toBe(400);
    const ok = await request(app).post('/api/auth/register').send(ngo());
    expect(ok.status).toBe(201);
    expect(ok.body.user.organisation.ngoType).toBe('ORPHANAGE');
    expect(ok.body.user.organisation.showInDirectory).toBe(false); // opt-in, off by default
    expect(ok.body.user.organisation.contactEmail).toBeNull(); // never copied from the personal account
  });

  it('daily capacity must be believable: at most 3 servings per person served', async () => {
    const res = await request(app).post('/api/auth/register').send(ngo({ dailyCapacity: 500, beneficiaries: 40 }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toMatch(/servings per person/);
  });

  it('database CHECK: donor businesses cannot carry NGO fields', async () => {
    const donor = await user('restaurant@foodrescue.test');
    await expect(prisma.organisation.update({ where: { id: donor.organisationId }, data: { showInDirectory: true } })).rejects.toThrow(/chk_org_ngo_fields/);
  });
});

describe('a declined offer is never re-offered', () => {
  it('after the NGO rejects it', async () => {
    const listing = await makeListing({ quantity: 40 });
    const r = await makeRequest({ quantity: 20 });
    const a = await createAllocation({ listingId: listing.id, requestId: r.id, quantity: 20 });
    await rejectAllocation(await user('ngo@foodrescue.test'), a.id, { reason: 'No space today' });
    await expect(createAllocation({ listingId: listing.id, requestId: r.id, quantity: 20 })).rejects.toMatchObject({ status: 409, details: { code: 'ALREADY_DECLINED' } });

    // The same food can still go to a different NGO
    const other = await makeRequest({ quantity: 20, email: 'ngo2@foodrescue.test' });
    await expect(createAllocation({ listingId: listing.id, requestId: other.id, quantity: 20 })).resolves.toMatchObject({ status: 'PROPOSED' });
  });

  it('after the offer expired without an answer', async () => {
    const listing = await makeListing({ quantity: 40 });
    const r = await makeRequest({ quantity: 15 });
    const a = await createAllocation({ listingId: listing.id, requestId: r.id, quantity: 15 });
    await simulateExpiry(await user('admin@foodrescue.test'), { allocationId: a.id });
    expect((await prisma.allocation.findUnique({ where: { id: a.id } })).status).toBe('EXPIRED');
    await expect(createAllocation({ listingId: listing.id, requestId: r.id, quantity: 15 })).rejects.toMatchObject({ status: 409 });
  });
});

describe('a listing always belongs to the donor business', () => {
  it('event leftovers keep the marquee as the owner, plus the event', async () => {
    const caterer = await user('caterer@foodrescue.test');
    const event = await prisma.event.create({ data: { organisationId: caterer.organisationId, name: 'Mehndi', date: new Date(), venue: 'Hall B', expectedGuests: 300, status: 'COMPLETED' } });
    const listing = await createListing(caterer, {
      eventId: event.id, categoryId: 1, description: 'Mehndi leftovers', confirmedQuantity: 60,
      preparedAt: new Date(Date.now() - 30 * 60_000), safeUntil: inHours(4), collectionDeadline: inHours(3), safetyConfirmed: true,
    });
    expect(listing.organisationId).toBe(caterer.organisationId);
    expect(listing.eventId).toBe(event.id);
    expect(listing.sourceType).toBe('EVENT');
    expect(listing.donorName).toBe('Park Road Banquet Hall (event: Mehndi)');

    // A marquee cannot list food without an event, and cannot use someone else's event
    await expect(createListing(caterer, { categoryId: 1, description: 'x', confirmedQuantity: 10, preparedAt: new Date(), safeUntil: inHours(4), collectionDeadline: inHours(3), safetyConfirmed: true })).rejects.toMatchObject({ status: 400 });
    const serena = await user('events@foodrescue.test');
    await expect(createListing(serena, { eventId: event.id, categoryId: 1, description: 'x', confirmedQuantity: 10, preparedAt: new Date(), safeUntil: inHours(4), collectionDeadline: inHours(3), safetyConfirmed: true })).rejects.toMatchObject({ status: 403 });
  });
});

describe('public NGO directory for households (opt-in)', () => {
  it('lists only verified NGOs that opted in, with only public details, without login', async () => {
    const res = await request(app).get('/api/ngos');
    expect(res.status).toBe(200);
    const names = res.body.ngos.map((n) => n.name);
    expect(names).toContain('Rizq');
    expect(names).not.toContain('Al-Khidmat Foundation Islamabad'); // still pending
    expect(names).not.toContain('Akhuwat Islamabad'); // verified but did not opt in
    expect(res.body.count).toBe(LISTED_NGOS.length);
    expect(res.body.disclaimer).toBe('FoodRescue does not handle or verify these donations.');
    const rizq = res.body.ngos.find((n) => n.name === 'Rizq');
    expect(rizq.ngoType).toBe('FOOD_KITCHEN');
    expect(rizq.contactPhone).toMatch(/^0300-00/);
    for (const hidden of ['address', 'latitude', 'longitude', 'users', 'dailyCapacity', 'beneficiaries', 'licenceNumber']) {
      expect(rizq[hidden]).toBeUndefined();
    }
    expect(rizq.distanceKm).toBeNull();
  });

  it('an NGO joins the directory by opting in on its profile, and needs a public contact for it', async () => {
    const token = await login('akhuwat@foodrescue.test');
    await request(app).patch('/api/auth/me').set(auth(token)).send({ organisation: { contactPhone: null, contactEmail: null } });
    const noContact = await request(app).patch('/api/auth/me').set(auth(token)).send({ organisation: { showInDirectory: true } });
    expect(noContact.status).toBe(400);

    const ok = await request(app).patch('/api/auth/me').set(auth(token)).send({ organisation: { showInDirectory: true, contactPhone: '051-0000000' } });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/ngos')).body.ngos.map((n) => n.name)).toContain('Akhuwat Islamabad');

    await request(app).patch('/api/auth/me').set(auth(token)).send({ organisation: { showInDirectory: false } });
    expect((await request(app).get('/api/ngos')).body.ngos.map((n) => n.name)).not.toContain('Akhuwat Islamabad');
  });

  it('filters by NGO type', async () => {
    const res = await request(app).get('/api/ngos').query({ ngoType: 'ORPHANAGE' });
    const expected = LISTED_NGOS.filter((n) => n[7] === 'ORPHANAGE').map((n) => n[1]).sort();
    expect(expected).toContain("SOS Children's Village Islamabad");
    expect(res.body.ngos.map((n) => n.name).sort()).toEqual(expected);
  });

  it('sorts by distance from the household area (manual area fallback) and flags coverage', async () => {
    const res = await request(app).get('/api/ngos').query({ area: 'f-8' });
    expect(res.body.yourLocation.area).toBe('F-8');
    expect(res.body.ngos[0].name).toBe('Rizq'); // based in F-8
    expect(res.body.ngos[0].servesYourArea).toBe(true);
    const d = res.body.ngos.map((n) => n.distanceKm);
    const served = res.body.ngos.filter((n) => n.servesYourArea).map((n) => n.distanceKm);
    expect(served).toEqual([...served].sort((a, b) => a - b));
    expect(d.every((x) => typeof x === 'number')).toBe(true);
  });

  it('accepts a map point, validates input, and hides inactive or unverified NGOs', async () => {
    const near = await request(app).get('/api/ngos').query({ lat: 33.7, lng: 73.03 });
    expect(near.status).toBe(200);
    expect(near.body.ngos.every((n) => typeof n.distanceKm === 'number')).toBe(true);

    expect((await request(app).get('/api/ngos').query({ lat: 33.7 })).status).toBe(400);

    const pending = await prisma.organisation.findFirst({ where: { name: 'Al-Khidmat Foundation Islamabad' } });
    expect((await request(app).get(`/api/ngos/${pending.id}`)).status).toBe(404);

    const robin = await prisma.organisation.findFirst({ where: { name: 'Robin Hood Army Islamabad' } });
    expect((await request(app).get(`/api/ngos/${robin.id}`)).body.ngo.name).toBe('Robin Hood Army Islamabad');
    await prisma.user.updateMany({ where: { organisationId: robin.id }, data: { active: false } });
    expect((await request(app).get('/api/ngos')).body.ngos.map((n) => n.name)).not.toContain('Robin Hood Army Islamabad');
    await prisma.user.updateMany({ where: { organisationId: robin.id }, data: { active: true } });
  });
});

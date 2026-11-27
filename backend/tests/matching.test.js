// Matching engine (Member 2): stage-1 rules, stage-2 score, greedy pooling,
// decision log, the never-re-offer rule and the weight comparison.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, makeListing, makeRequest, prisma, user } from './helpers.js';
import { createApp } from '../src/app.js';
import { runMatching } from '../src/modules/matching/matching.service.js';
import { checkPair, scorePair, comparePairs } from '../src/modules/matching/matching.rules.js';
import { registerMatchingRunner } from '../src/modules/matching/matching.trigger.js';
import { rejectAllocation, cancelAllocation, acceptAllocation, createAllocation } from '../src/modules/allocations/allocation.service.js';
import { simulateExpiry } from '../src/modules/notifications-admin/admin.service.js';
import { MAX_OFFERS_PER_RUN } from '../src/modules/matching/matching.service.js';
import { listingQuantity } from '../src/lib/quantities.js';

const app = createApp();
const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'Password123' })).body.token;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

// Close the seeded open listings and requests so each test controls exactly what is open
async function isolate() {
  await prisma.surplusListing.updateMany({ where: { status: 'OPEN' }, data: { status: 'CLOSED' } });
  await prisma.nGORequest.updateMany({ where: { status: 'OPEN' }, data: { status: 'CANCELLED' } });
}

beforeAll(async () => {
  await resetDb();
  registerMatchingRunner(runMatching); // other test files may have swapped it
});
beforeEach(isolate);
afterAll(() => prisma.$disconnect());

describe('matching rules (pure functions)', () => {
  const now = new Date();
  const org = { type: 'RESTAURANT', verificationStatus: 'VERIFIED', licenceExpiresOn: null };
  const ngo = { type: 'NGO', verificationStatus: 'VERIFIED', latitude: 33.71, longitude: 73.04, serviceRadiusKm: 15, dailyCapacity: 400 };
  const listing = (over = {}) => ({
    id: 1, categoryId: 1, category: { name: 'Cooked meals' }, organisation: org, latitude: 33.712, longitude: 73.061,
    preparedAt: new Date(+now - 3_600_000), safeUntil: new Date(+now + 4 * 3_600_000), collectionDeadline: new Date(+now + 3 * 3_600_000), ...over,
  });
  const req = (over = {}) => ({ id: 1, ngoId: 9, categoryId: 1, category: { name: 'Cooked meals' }, ngo, requiredBy: new Date(+now + 5 * 3_600_000), ...over });
  const cfg = { minAllocation: 5, nearExpiryHours: 2, nearExpiryKm: 5, speedKmh: 25 };
  const ctx = (over = {}) => ({ now, cfg, remaining: 40, remainingNeed: 30, capacityLeft: 400, declined: false, weights: { freshness: 30, feasibility: 25, quantityFit: 20, proximity: 15, fairness: 10 }, received: 0, maxReceived: 0, ...over });

  it('explains a category mismatch in plain words', () => {
    const r = checkPair(listing(), req({ categoryId: 3, category: { name: 'Bread and bakery' } }), ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Cooked meals.*Bread and bakery/);
  });

  it('applies the near-expiry rule: under 2 hours only NGOs within 5 km qualify', () => {
    const urgent = listing({ safeUntil: new Date(+now + 90 * 60_000), collectionDeadline: new Date(+now + 80 * 60_000) });
    const farNgo = { ...ngo, latitude: 33.68, longitude: 72.99 }; // ~7 km from the food
    const r = checkPair(urgent, req({ ngo: farNgo }), ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/within 5 km/);
    expect(checkPair(urgent, req(), ctx()).ok).toBe(true); // ~2 km away: allowed
  });

  it('refuses pairs outside the service radius, past deadlines or already declined', () => {
    expect(checkPair(listing(), req({ ngo: { ...ngo, serviceRadiusKm: 1 } }), ctx()).reason).toMatch(/service radius/);
    expect(checkPair(listing({ collectionDeadline: new Date(+now + 5 * 60_000) }), req(), ctx()).reason).toMatch(/collection closes/);
    expect(checkPair(listing(), req({ requiredBy: new Date(+now + 10 * 60_000) }), ctx()).reason).toMatch(/required-by/);
    expect(checkPair(listing(), req(), ctx({ declined: true })).reason).toMatch(/not offered again/);
    expect(checkPair(listing(), req(), ctx({ capacityLeft: 0 })).reason).toMatch(/daily capacity/);
  });

  it('scores out of 100, rescue-first: food closer to expiry scores higher on freshness', () => {
    const a = listing();
    const soon = listing({ id: 2, preparedAt: new Date(+now - 4 * 3_600_000), safeUntil: new Date(+now + 2.5 * 3_600_000), collectionDeadline: new Date(+now + 2 * 3_600_000) });
    const sa = scorePair(a, req(), checkPair(a, req(), ctx()), ctx());
    const ss = scorePair(soon, req(), checkPair(soon, req(), ctx()), ctx());
    expect(sa.score).toBeGreaterThan(0);
    expect(sa.score).toBeLessThanOrEqual(100);
    expect(ss.breakdown.freshness.value).toBeGreaterThan(sa.breakdown.freshness.value);
  });

  it('fairness: an NGO that received less recently scores higher', () => {
    const l = listing();
    const check = checkPair(l, req(), ctx());
    const fed = scorePair(l, req(), check, ctx({ received: 200, maxReceived: 200 }));
    const hungry = scorePair(l, req(), check, ctx({ received: 0, maxReceived: 200 }));
    expect(hungry.breakdown.fairness.points).toBe(10);
    expect(fed.breakdown.fairness.points).toBe(0);
  });

  it('breaks score ties in favour of the food that expires sooner', () => {
    const x = { score: 70, listing: { id: 1, safeUntil: new Date(+now + 3e6) }, request: { id: 1, requiredBy: now } };
    const y = { score: 70, listing: { id: 2, safeUntil: new Date(+now + 1e6) }, request: { id: 1, requiredBy: now } };
    expect([x, y].sort(comparePairs)[0].listing.id).toBe(2);
  });
});

describe('matching engine (database)', () => {
  it('offers food to a request, with a score, breakdown, explanation and decision rows', async () => {
    const l = await makeListing({ quantity: 50 });
    const r = await makeRequest({ quantity: 30 });
    const result = await runMatching({ reason: 'test' });
    expect(result.offers).toBe(1);
    const a = await prisma.allocation.findFirstOrThrow({ where: { requestId: r.id } });
    expect(a).toMatchObject({ listingId: l.id, quantity: 30, status: 'PROPOSED' });
    expect(a.score).toBeGreaterThan(0);
    expect(a.scoreBreakdown.freshness.weight).toBe(30);
    expect(a.explanation).toMatch(/Offered 30 of 30/);

    const ngo = await login('ngo@foodrescue.test');
    const why = await request(app).get(`/api/requests/${r.id}/match-decisions`).set(auth(ngo));
    expect(why.status).toBe(200);
    expect(why.body.decisions[0]).toMatchObject({ eligible: true, offer: { quantity: 30 } });
  });

  it('pools several donors into one large request', async () => {
    await makeListing({ quantity: 20 });
    await makeListing({ quantity: 20 });
    const r = await makeRequest({ quantity: 35 });
    await runMatching({ reason: 'test' });
    const offers = await prisma.allocation.findMany({ where: { requestId: r.id } });
    expect(offers).toHaveLength(2);
    expect(offers.reduce((s, a) => s + a.quantity, 0)).toBe(35);
  });

  it('splits one listing across several NGOs and never over-allocates', async () => {
    const l = await makeListing({ quantity: 50 });
    await makeRequest({ quantity: 30, email: 'ngo@foodrescue.test' });
    await makeRequest({ quantity: 30, email: 'ngo2@foodrescue.test' });
    await runMatching({ reason: 'test' });
    const offers = await prisma.allocation.findMany({ where: { listingId: l.id } });
    expect(offers.length).toBe(2);
    expect(offers.reduce((s, a) => s + a.quantity, 0)).toBe(50);
    expect((await listingQuantity(prisma, l)).remaining).toBe(0);
  });

  it('never re-offers food that the NGO rejected, and says why', async () => {
    const l = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 30 });
    await runMatching({ reason: 'test' });
    const a = await prisma.allocation.findFirstOrThrow({ where: { requestId: r.id } });
    await rejectAllocation(await user('ngo@foodrescue.test'), a.id, { reason: 'too far' });
    const again = await runMatching({ reason: 'test-after-reject' });
    expect(again.offers).toBe(0);
    const d = await prisma.matchDecision.findFirstOrThrow({ where: { runId: again.runId, listingId: l.id, requestId: r.id } });
    expect(d.eligible).toBe(false);
    expect(d.rejectionReason).toMatch(/not offered again/);
  });

  it('does nothing harmful when there is nothing to match', async () => {
    const result = await runMatching({ reason: 'empty' });
    expect(result.offers).toBe(0);
  });

  it('runs from the admin "run matching" button', async () => {
    await makeListing({ quantity: 25 });
    await makeRequest({ quantity: 25 });
    const admin = await login('admin@foodrescue.test');
    const res = await request(app).post('/api/admin/matching/run').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(true);
    expect(res.body.result.offers).toBe(1);
  });

  it('weight comparison uses the real engine and saves nothing', async () => {
    await makeListing({ quantity: 30 });
    await makeRequest({ quantity: 30, email: 'ngo@foodrescue.test' });
    await makeRequest({ quantity: 30, email: 'ngo2@foodrescue.test' });
    const before = await prisma.allocation.count();
    const admin = await login('admin@foodrescue.test');
    const res = await request(app)
      .post('/api/admin/matching/compare')
      .set(auth(admin))
      .send({ weightSets: [{ name: 'Proximity first', weights: { freshness: 10, feasibility: 10, quantityFit: 10, proximity: 60, fairness: 10 } }] });
    expect(res.status).toBe(200);
    expect(res.body.savedAnything).toBe(false);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].allocations).toBe(1);
    expect(await prisma.allocation.count()).toBe(before);
  });

  it('makes at most MAX_OFFERS_PER_RUN offers per run and says more are waiting', async () => {
    for (let i = 0; i < MAX_OFFERS_PER_RUN + 2; i++) await makeListing({ quantity: 10 });
    await makeRequest({ quantity: 100 });
    const first = await runMatching({ reason: 'cap-test' });
    expect(first.offers).toBe(MAX_OFFERS_PER_RUN);
    expect(first.more).toBe(true);
    const second = await runMatching({ reason: 'cap-test-2' });
    expect(second.offers).toBe(2);
    expect(second.more).toBe(false);
  });

  it('scales weights that do not add up to 100, so scores stay out of 100', async () => {
    await makeListing({ quantity: 20 });
    await makeRequest({ quantity: 20 });
    const r = await runMatching({ reason: 'weights', weights: { freshness: 10, feasibility: 10, quantityFit: 10, proximity: 10, fairness: 10 } });
    const a = await prisma.allocation.findUniqueOrThrow({ where: { id: r.allocations[0].allocationId } });
    expect(a.scoreBreakdown.freshness.weight).toBe(20);
    expect(a.score).toBeLessThanOrEqual(100);
  });

  it('respects the 2-hour near-expiry rule end to end', async () => {
    // Food with 90 minutes left, ~7 km from Rizq (F-8): Rizq must not get it
    const l = await makeListing({ quantity: 20, safeHours: 1.5, deadlineHours: 1.3 });
    await prisma.surplusListing.update({ where: { id: l.id }, data: { latitude: 33.66965, longitude: 73.134633 } });
    const r = await makeRequest({ quantity: 20 });
    const result = await runMatching({ reason: 'test' });
    expect(result.offers).toBe(0);
    const d = await prisma.matchDecision.findFirstOrThrow({ where: { runId: result.runId, requestId: r.id } });
    expect(d.rejectionReason).toMatch(/within 5 km/);
  });
});

describe('declined offers (shared rule for the engine and manual offers)', () => {
  it('an offer the NGO cancelled itself is never offered to it again', async () => {
    const l = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 20 });
    const a = await createAllocation({ listingId: l.id, requestId: r.id, quantity: 20 });
    const ngo = await user('ngo@foodrescue.test');
    await acceptAllocation(ngo, a.id);
    await cancelAllocation(ngo, a.id, { reason: 'Our van broke down' });
    await expect(createAllocation({ listingId: l.id, requestId: r.id, quantity: 20 })).rejects.toMatchObject({ details: { code: 'ALREADY_DECLINED' } });
    expect((await runMatching({ reason: 'after-cancel' })).offers).toBe(0);
  });

  it('an accepted offer that expired because nobody collected it does NOT block the NGO', async () => {
    const l = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 20 });
    const a = await createAllocation({ listingId: l.id, requestId: r.id, quantity: 20 });
    await acceptAllocation(await user('ngo@foodrescue.test'), a.id);
    await simulateExpiry(await user('admin@foodrescue.test'), { allocationId: a.id });
    expect((await prisma.allocation.findUnique({ where: { id: a.id } })).status).toBe('EXPIRED');
    await expect(createAllocation({ listingId: l.id, requestId: r.id, quantity: 20 })).resolves.toMatchObject({ status: 'PROPOSED' });
  });

  it('cannot accept food whose donor licence expired after the offer was made', async () => {
    const l = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 20 });
    const a = await createAllocation({ listingId: l.id, requestId: r.id, quantity: 20 });
    await prisma.organisation.update({ where: { id: l.organisationId }, data: { licenceExpiresOn: new Date('2020-01-01') } });
    await expect(acceptAllocation(await user('ngo@foodrescue.test'), a.id)).rejects.toMatchObject({ status: 409 });
    await prisma.organisation.update({ where: { id: l.organisationId }, data: { licenceExpiresOn: null } });
  });
});

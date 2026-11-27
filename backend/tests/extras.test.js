// Extra evidence features: live concurrency demo, "why wasn't I matched?", and
// weight comparison (dry run that never saves anything).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, makeListing, makeRequest, prisma } from './helpers.js';
import { createApp } from '../src/app.js';
import { registerMatchingRunner } from '../src/modules/matching/matching.trigger.js';
import { createAllocationLocked } from '../src/modules/allocations/allocation.service.js';
import { listingQuantity, requestQuantity } from '../src/lib/quantities.js';

const app = createApp();
const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'Password123' })).body.token;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(resetDb);
afterAll(async () => {
  registerMatchingRunner(null);
  await prisma.$disconnect();
});

describe('live concurrency demo (POST /api/admin/demo/concurrency)', () => {
  it('with the lock never over-allocates; without it the race shows; demo data is cleaned up', async () => {
    const admin = await login('admin@foodrescue.test');
    const res = await request(app).post('/api/admin/demo/concurrency').set(auth(admin)).send({ attempts: 8, compare: true });
    expect(res.status).toBe(200);
    expect(res.body.withLock).toMatchObject({ attempts: 8, succeeded: 5, refused: 3, servingsAllocated: 50, overAllocated: false });
    expect(res.body.withoutLock.overAllocated).toBe(true);
    expect(res.body.withoutLock.servingsAllocated).toBeGreaterThan(50);

    // cleaned up: no demo listing or request left open, no naive rows left
    expect(await prisma.surplusListing.count({ where: { description: { startsWith: '[DEMO' }, status: 'OPEN' } })).toBe(0);
    expect(await prisma.nGORequest.count({ where: { notes: { startsWith: '[DEMO' }, status: 'OPEN' } })).toBe(0);
    expect(await prisma.allocation.count({ where: { explanation: 'NAIVE demo row' } })).toBe(0);
  });

  it('is admin-only', async () => {
    const ngo = await login('ngo@foodrescue.test');
    expect((await request(app).post('/api/admin/demo/concurrency').set(auth(ngo)).send({})).status).toBe(403);
  });
});

describe('"why wasn\'t I matched?" (GET /api/requests/:id/match-decisions)', () => {
  it('explains each listing the latest run considered, only to the owning NGO', async () => {
    const r = await makeRequest({ quantity: 20 });
    const ngo = await login('ngo@foodrescue.test');
    const empty = await request(app).get(`/api/requests/${r.id}/match-decisions`).set(auth(ngo));
    expect(empty.body.decisions).toEqual([]);
    expect(empty.body.message).toMatch(/No matching run/);

    const near = await makeListing({ quantity: 30 });
    const far = await makeListing({ quantity: 30 });
    await prisma.matchDecision.createMany({
      data: [
        { runId: 'run-1', listingId: far.id, requestId: r.id, eligible: false, rejectionReason: 'estimated arrival 45 min is after the 30 min collection deadline' },
        { runId: 'run-1', listingId: near.id, requestId: r.id, eligible: true, score: 87.5, scoreBreakdown: { freshness: 27, feasibility: 22, quantityFit: 20, proximity: 12, fairness: 6.5 } },
      ],
    });

    const res = await request(app).get(`/api/requests/${r.id}/match-decisions`).set(auth(ngo));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runId: 'run-1', considered: 2, eligible: 1 });
    const rejected = res.body.decisions.find((d) => !d.eligible);
    expect(rejected.summary).toBe('Not offered: estimated arrival 45 min is after the 30 min collection deadline.');
    expect(rejected.listing.address).toBeUndefined(); // donor location stays private
    const eligible = res.body.decisions.find((d) => d.eligible);
    expect(eligible.summary).toMatch(/score 87\.5/);

    const otherNgo = await login('ngo2@foodrescue.test');
    expect((await request(app).get(`/api/requests/${r.id}/match-decisions`).set(auth(otherNgo))).status).toBe(403);
  });
});

describe('weight comparison (POST /api/admin/matching/compare)', () => {
  const alternative = { name: 'Proximity first', weights: { freshness: 10, feasibility: 10, quantityFit: 10, proximity: 60, fairness: 10 } };

  it('returns 501 until the matching engine is installed', async () => {
    registerMatchingRunner(null);
    const admin = await login('admin@foodrescue.test');
    const res = await request(app).post('/api/admin/matching/compare').set(auth(admin)).send({ weightSets: [alternative] });
    expect(res.status).toBe(501);
  });

  it('rejects weights that do not add up to 100', async () => {
    const admin = await login('admin@foodrescue.test');
    const bad = { name: 'Bad', weights: { freshness: 50, feasibility: 50, quantityFit: 50, proximity: 0, fairness: 0 } };
    expect((await request(app).post('/api/admin/matching/compare').set(auth(admin)).send({ weightSets: [bad] })).status).toBe(400);
  });

  it('runs the engine once per weight set, shows different outcomes, and saves NOTHING', async () => {
    await resetDb();
    // Stand-in engine for this test only (the real one is Member 2's): it prefers
    // Robin Hood Army when proximity weight > 50, otherwise Rizq.
    registerMatchingRunner(async ({ tx, weights }) => {
      const listings = await tx.surplusListing.findMany({ where: { status: 'OPEN' } });
      const requests = await tx.nGORequest.findMany({ where: { status: 'OPEN' }, include: { ngo: true } });
      const preferCityBank = (weights?.proximity ?? 0) > 50;
      requests.sort((a, b) => Number(b.ngo.name === 'Robin Hood Army Islamabad') - Number(a.ngo.name === 'Robin Hood Army Islamabad'));
      if (!preferCityBank) requests.reverse();
      for (const l of listings) {
        for (const r of requests) {
          const left = (await listingQuantity(tx, l)).remaining;
          const need = (await requestQuantity(tx, r)).remainingNeed;
          const qty = Math.min(left, need);
          if (qty > 0) await createAllocationLocked(tx, { listingId: l.id, requestId: r.id, quantity: qty, score: preferCityBank ? 70 : 80 });
        }
      }
    });
    await makeListing({ quantity: 30 });
    await makeRequest({ quantity: 30, email: 'ngo@foodrescue.test' });
    await makeRequest({ quantity: 30, email: 'ngo2@foodrescue.test' });
    const before = { allocations: await prisma.allocation.count(), notifications: await prisma.notification.count(), history: await prisma.statusHistory.count() };

    const admin = await login('admin@foodrescue.test');
    const res = await request(app).post('/api/admin/matching/compare').set(auth(admin)).send({ weightSets: [alternative] });
    expect(res.status).toBe(200);
    expect(res.body.savedAnything).toBe(false);
    const [current, alt] = res.body.results;
    expect(current.name).toBe('Current settings');
    expect(current.weights).toEqual({ freshness: 30, feasibility: 25, quantityFit: 20, proximity: 15, fairness: 10 });
    expect(current).toMatchObject({ allocations: 1, totalServings: 30, ngosServed: 1 });
    expect(current.perNgo[0].ngo).toBe('Rizq');
    expect(alt.perNgo[0].ngo).toBe('Robin Hood Army Islamabad');

    // Nothing was written: no allocations, notifications or history rows
    expect(await prisma.allocation.count()).toBe(before.allocations);
    expect(await prisma.notification.count()).toBe(before.notifications);
    expect(await prisma.statusHistory.count()).toBe(before.history);
  });
});

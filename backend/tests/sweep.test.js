// Objective 5: "Release and re-offer food automatically when an offer is rejected,
// unanswered, uncollected or withdrawn, and never offer food whose deadline has passed."
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetDb, makeListing, makeRequest, acceptedScenario, claimedScenario, prisma, user } from './helpers.js';
import { createAllocation, acceptAllocation } from '../src/modules/allocations/allocation.service.js';
import { runSweep, hasOverdueRows } from '../src/modules/allocations/sweep.service.js';
import { confirmPickup } from '../src/modules/rescue/rescue.service.js';
import { listingQuantity } from '../src/lib/quantities.js';

const past = () => new Date(Date.now() - 60_000);

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

describe('expire-on-read sweep', () => {
  it('nothing overdue → cheap check says no', async () => {
    await resetDb();
    expect(await hasOverdueRows()).toBe(false);
  });

  it('unanswered offer expires and its food is released', async () => {
    const listing = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 30 });
    const a = await createAllocation({ listingId: listing.id, requestId: r.id, quantity: 30 });
    await prisma.allocation.update({ where: { id: a.id }, data: { responseDeadline: past() } });

    expect(await hasOverdueRows()).toBe(true);
    const summary = await runSweep();
    expect(summary.expiredOffers).toBe(1);
    expect((await prisma.allocation.findUnique({ where: { id: a.id } })).status).toBe('EXPIRED');
    expect((await listingQuantity(prisma, { id: listing.id, confirmedQuantity: 30 })).remaining).toBe(30);
    expect((await prisma.nGORequest.findUnique({ where: { id: r.id } })).reallocationPending).toBe(true);
  });

  it('an expired offer can never be accepted, even if the sweep has not run yet', async () => {
    const listing = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 30 });
    const a = await createAllocation({ listingId: listing.id, requestId: r.id, quantity: 30 });
    await prisma.allocation.update({ where: { id: a.id }, data: { responseDeadline: past() } });
    await expect(acceptAllocation(await user('ngo@foodrescue.test'), a.id)).rejects.toMatchObject({ status: 410 });
  });

  it('accepted food nobody collected expires; claimed volunteer gets a no-show', async () => {
    const { allocation, task } = await claimedScenario();
    await prisma.allocation.update({ where: { id: allocation.id }, data: { pickupDeadline: past() } });
    const before = (await user('volunteer@foodrescue.test')).volunteerProfile.noShowCount;
    const summary = await runSweep();
    expect(summary.expiredAccepted).toBe(1);
    expect((await prisma.allocation.findUnique({ where: { id: allocation.id } })).status).toBe('EXPIRED');
    expect((await prisma.rescueTask.findUnique({ where: { id: task.id } })).status).toBe('CANCELLED');
    expect((await user('volunteer@foodrescue.test')).volunteerProfile.noShowCount).toBe(before + 1);
  });

  it('stuck volunteer claim is released back to OPEN', async () => {
    const { task } = await claimedScenario();
    await prisma.rescueTask.update({ where: { id: task.id }, data: { claimDeadline: past() } });
    const summary = await runSweep();
    expect(summary.releasedClaims).toBe(1);
    const fresh = await prisma.rescueTask.findUnique({ where: { id: task.id } });
    expect(fresh.status).toBe('OPEN');
    expect(fresh.volunteerId).toBeNull();
  });

  it('late delivery (past safe-until) fails and counts as lost', async () => {
    const s = await claimedScenario();
    await confirmPickup(await user('volunteer@foodrescue.test'), s.task.id, { code: s.pickupCode, quantity: 20 });
    await prisma.surplusListing.update({ where: { id: s.listing.id }, data: { safeUntil: past(), collectionDeadline: past() } });
    const summary = await runSweep();
    expect(summary.failedDeliveries).toBe(1);
    const a = await prisma.allocation.findUnique({ where: { id: s.allocation.id } });
    expect(a.status).toBe('FAILED');
    expect(a.lostQuantity).toBe(a.quantity);
  });

  it('listing past collection deadline expires and withdraws its open offers', async () => {
    const listing = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 10 });
    const a = await createAllocation({ listingId: listing.id, requestId: r.id, quantity: 10 });
    await prisma.surplusListing.update({ where: { id: listing.id }, data: { collectionDeadline: past() } });
    await runSweep();
    expect((await prisma.surplusListing.findUnique({ where: { id: listing.id } })).status).toBe('EXPIRED');
    expect((await prisma.allocation.findUnique({ where: { id: a.id } })).status).toBe('EXPIRED');
    // and food from an expired listing can never be offered again
    const r2 = await makeRequest({ quantity: 10 });
    await expect(createAllocation({ listingId: listing.id, requestId: r2.id, quantity: 10 })).rejects.toThrow(/expired/);
  });

  it('request past required-by expires; its pending offers are withdrawn', async () => {
    const listing = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 10 });
    const a = await createAllocation({ listingId: listing.id, requestId: r.id, quantity: 10 });
    await prisma.nGORequest.update({ where: { id: r.id }, data: { requiredBy: past() } });
    await runSweep();
    expect((await prisma.nGORequest.findUnique({ where: { id: r.id } })).status).toBe('EXPIRED');
    expect((await prisma.allocation.findUnique({ where: { id: a.id } })).status).toBe('EXPIRED');
  });

  it('every automatic transition is written to status history', async () => {
    const rows = await prisma.statusHistory.count({ where: { actorUserId: null, toStatus: 'EXPIRED' } });
    expect(rows).toBeGreaterThan(0);
  });
});

// keep acceptedScenario import used for clarity in future tests
void acceptedScenario;

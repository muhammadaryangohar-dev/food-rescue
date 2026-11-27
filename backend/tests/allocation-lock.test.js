// Objective 4 / NFR5: "Guarantee that no listing is allocated beyond its confirmed
// quantity, even under simultaneous requests".
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetDb, makeListing, makeRequest, prisma, user } from './helpers.js';
import { createAllocation, acceptAllocation } from '../src/modules/allocations/allocation.service.js';
import { listingQuantity } from '../src/lib/quantities.js';
import { AppError } from '../src/lib/errors.js';

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

describe('locked allocation transaction', () => {
  it('20 simultaneous allocations of 10 on a 50-serving listing: exactly 5 succeed', async () => {
    const listing = await makeListing({ quantity: 50 });
    const requests = [];
    for (let i = 0; i < 20; i++) requests.push(await makeRequest({ quantity: 10, email: i % 2 ? 'ngo@foodrescue.test' : 'ngo2@foodrescue.test' }));

    const results = await Promise.allSettled(requests.map((r) => createAllocation({ listingId: listing.id, requestId: r.id, quantity: 10 })));

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(5);
    expect(failed).toHaveLength(15);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(AppError);
      expect(f.reason.status).toBe(409);
    }

    const q = await listingQuantity(prisma, await prisma.surplusListing.findUnique({ where: { id: listing.id } }));
    expect(q.committed).toBe(50);
    expect(q.remaining).toBe(0);
    const sum = await prisma.allocation.aggregate({ where: { listingId: listing.id }, _sum: { quantity: true } });
    expect(sum._sum.quantity).toBe(50); // never more than confirmed
  });

  it('never over-fills a request from two listings at once', async () => {
    const a = await makeListing({ quantity: 30 });
    const b = await makeListing({ quantity: 30 });
    const r = await makeRequest({ quantity: 25 });
    const results = await Promise.allSettled([
      createAllocation({ listingId: a.id, requestId: r.id, quantity: 25 }),
      createAllocation({ listingId: b.id, requestId: r.id, quantity: 25 }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects category mismatch, unverified NGO and below-minimum sizes', async () => {
    const listing = await makeListing({ quantity: 30, categoryId: 1 });
    const wrongCat = await makeRequest({ quantity: 10, categoryId: 2 });
    await expect(createAllocation({ listingId: listing.id, requestId: wrongCat.id, quantity: 10 })).rejects.toThrow(/category/i);

    const r = await makeRequest({ quantity: 20 });
    await expect(createAllocation({ listingId: listing.id, requestId: r.id, quantity: 2 })).rejects.toThrow(/at least 5/);

    await prisma.organisation.update({ where: { id: (await user('ngo@foodrescue.test')).organisationId }, data: { verificationStatus: 'PENDING' } });
    await expect(createAllocation({ listingId: listing.id, requestId: r.id, quantity: 10 })).rejects.toThrow(/NGO is not verified/);
    await prisma.organisation.update({ where: { id: (await user('ngo@foodrescue.test')).organisationId }, data: { verificationStatus: 'VERIFIED' } });
  });

  it('released food (rejected offer) becomes available again, derived not stored', async () => {
    const listing = await makeListing({ quantity: 20 });
    const r1 = await makeRequest({ quantity: 20 });
    const a = await createAllocation({ listingId: listing.id, requestId: r1.id, quantity: 20 });
    expect((await listingQuantity(prisma, { ...listing, confirmedQuantity: 20 })).remaining).toBe(0);
    await prisma.allocation.update({ where: { id: a.id }, data: { status: 'REJECTED' } });
    expect((await listingQuantity(prisma, { ...listing, confirmedQuantity: 20 })).remaining).toBe(20);
  });

  it('two NGOs accepting at the same time: each only their own offer, both succeed safely', async () => {
    const listing = await makeListing({ quantity: 40 });
    const r1 = await makeRequest({ quantity: 20, email: 'ngo@foodrescue.test' });
    const r2 = await makeRequest({ quantity: 20, email: 'ngo2@foodrescue.test' });
    const a1 = await createAllocation({ listingId: listing.id, requestId: r1.id, quantity: 20 });
    const a2 = await createAllocation({ listingId: listing.id, requestId: r2.id, quantity: 20 });
    const [x, y] = await Promise.all([
      acceptAllocation(await user('ngo@foodrescue.test'), a1.id),
      acceptAllocation(await user('ngo2@foodrescue.test'), a2.id),
    ]);
    expect(x.status).toBe('ACCEPTED');
    expect(y.status).toBe('ACCEPTED');
  });
});

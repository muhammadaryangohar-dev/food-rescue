// Live concurrency demonstration (proposal objective 4). Used by
//   POST /api/admin/demo/concurrency          (admin "Run concurrency demo" button)
//   npm run demo:concurrency -- --compare     (command-line version)
//
// It creates one demo listing and N demo requests, then fires N allocation
// attempts at exactly the same moment:
//  - WITH the advisory lock (the real engine): the listing is never over-allocated.
//  - WITHOUT a lock (compare: true): a deliberately naive "read remaining, then
//    insert" version, used ONLY here, shows the race condition the lock prevents.
// Afterwards everything is cleaned up (listing withdrawn, requests cancelled, naive
// rows deleted), so the database stays consistent and matching is not disturbed.
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { USER_INCLUDE } from '../../middleware/auth.js';
import { LISTING_HOLDING, listingQuantity } from '../../lib/quantities.js';
import { createListing, withdrawListing } from '../listings/listing.service.js';
import { createRequest, cancelRequest } from '../matching/request.service.js';
import { createAllocation } from '../allocations/allocation.service.js';
import { withMatchingPaused } from '../matching/matching.trigger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Any verified restaurant donor and up to two verified NGOs (seed accounts work). */
async function findActors() {
  const donor = await prisma.user.findFirst({
    where: { role: 'DONOR', donorType: 'RESTAURANT', active: true, organisation: { verificationStatus: 'VERIFIED' } },
    include: USER_INCLUDE,
  });
  const ngoUsers = await prisma.user.findMany({
    where: { role: 'NGO', active: true, organisation: { verificationStatus: 'VERIFIED' } },
    include: USER_INCLUDE,
    distinct: ['organisationId'],
    take: 2,
  });
  const category = await prisma.foodCategory.findFirst({ where: { defaultSafeHours: { gte: 4 } }, orderBy: { id: 'asc' } });
  if (!donor || ngoUsers.length === 0 || !category) {
    throw badRequest('The demo needs a verified restaurant donor, a verified NGO and a food category (run npm run seed)');
  }
  return { donor, ngos: ngoUsers, category };
}

async function setup(actors, label, attempts, listingQty, each) {
  const { donor, ngos, category } = actors;
  const listing = await createListing(donor, {
    categoryId: category.id,
    description: `[DEMO ${label}] Concurrency demonstration`,
    confirmedQuantity: listingQty,
    preparedAt: new Date(Date.now() - 10 * 60_000),
    safeUntil: new Date(Date.now() + 4 * 3600_000),
    collectionDeadline: new Date(Date.now() + 3 * 3600_000),
    safetyConfirmed: true,
  });
  const requests = [];
  for (let i = 0; i < attempts; i++) {
    const ngo = ngos[i % ngos.length];
    requests.push(await createRequest(ngo, { categoryId: category.id, requestedQuantity: each, requiredBy: new Date(Date.now() + 5 * 3600_000), notes: `[DEMO ${label}]` }));
  }
  return { listing, requests };
}

async function cleanup(actors, { listing, requests }) {
  await withdrawListing(actors.donor, listing.id, { reason: 'Concurrency demo finished' }).catch(() => {});
  for (const r of requests) {
    const owner = actors.ngos.find((n) => n.organisationId === r.ngoId);
    await cancelRequest(owner, r.id, { reason: 'Concurrency demo finished' }).catch(() => {});
  }
}

function summarise(results, allocated, listingQty, ms) {
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  return {
    attempts: results.length,
    succeeded,
    refused: results.length - succeeded,
    servingsAllocated: allocated,
    servingsConfirmed: listingQty,
    overAllocated: allocated > listingQty,
    durationMs: ms,
    refusalReasons: [...new Set(results.filter((r) => r.status === 'rejected').map((r) => r.reason.message))],
  };
}

export async function runConcurrencyDemo({ attempts = 10, compare = false, listingQty = 50, each = 10 } = {}) {
  return withMatchingPaused(async () => {
    const actors = await findActors();
    const out = { scenario: `One listing of ${listingQty} servings; ${attempts} NGO requests of ${each} servings fired at the same moment.` };

    // 1. The real engine, protected by the advisory lock
    const safe = await setup(actors, 'LOCKED', attempts, listingQty, each);
    let t = Date.now();
    const results = await Promise.allSettled(safe.requests.map((r) => createAllocation({ listingId: safe.listing.id, requestId: r.id, quantity: each, explanation: 'Concurrency demo' })));
    const q = await listingQuantity(prisma, { id: safe.listing.id, confirmedQuantity: listingQty });
    out.withLock = summarise(results, q.committed, listingQty, Date.now() - t);
    await cleanup(actors, safe);

    // 2. Naive check-then-insert WITHOUT a lock, for comparison only
    if (compare) {
      const naive = await setup(actors, 'NAIVE', attempts, listingQty, each);
      const ids = [];
      t = Date.now();
      const naiveResults = await Promise.allSettled(
        naive.requests.map(async (r) => {
          const sum = await prisma.allocation.aggregate({ where: { listingId: naive.listing.id, status: { in: LISTING_HOLDING } }, _sum: { quantity: true } });
          const remaining = listingQty - (sum._sum.quantity || 0);
          await sleep(50); // the gap between "check" and "write" where another request sneaks in
          if (each > remaining) throw new Error(`Only ${remaining} left`);
          const a = await prisma.allocation.create({ data: { listingId: naive.listing.id, requestId: r.id, quantity: each, responseDeadline: new Date(Date.now() + 1800_000), explanation: 'NAIVE demo row' } });
          ids.push(a.id);
        }),
      );
      const sum = await prisma.allocation.aggregate({ where: { listingId: naive.listing.id }, _sum: { quantity: true } });
      out.withoutLock = summarise(naiveResults, sum._sum.quantity || 0, listingQty, Date.now() - t);
      await prisma.allocation.deleteMany({ where: { id: { in: ids } } }); // remove the invalid rows
      await cleanup(actors, naive);
    }

    out.cleanedUp = true;
    return out;
  });
}

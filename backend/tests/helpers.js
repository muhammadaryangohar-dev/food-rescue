// Test helpers: reset the TEST database, seed it, and build scenarios quickly.
// Tests run against DATABASE_URL from .env.test (a local database), never Neon.
import { prisma } from '../src/lib/prisma.js';
import { seed } from '../prisma/seed.js';
import { USER_INCLUDE } from '../src/middleware/auth.js';
import { invalidateConfigCache } from '../src/lib/config.js';
import { createListing } from '../src/modules/listings/listing.service.js';
import { createRequest } from '../src/modules/matching/request.service.js';
import { createAllocation, acceptAllocation } from '../src/modules/allocations/allocation.service.js';
import { claimTask } from '../src/modules/rescue/rescue.service.js';
import { deriveOtp } from '../src/lib/otp.js';

if (!process.env.DATABASE_URL?.includes('localhost')) {
  throw new Error('Refusing to run tests against a non-local database. Check .env.test');
}

const TABLES = [
  'match_decisions', 'handover_records', 'reports', 'rescue_tasks', 'allocations', 'ngo_requests',
  'surplus_listings', 'event_food_plans', 'events', 'daily_food_records', 'food_items', 'notifications',
  'status_history', 'system_config', 'volunteer_profiles', 'users', 'organisations', 'food_categories',
];

export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await seed(prisma);
  invalidateConfigCache();
}

export const user = (email) => prisma.user.findUniqueOrThrow({ where: { email }, include: USER_INCLUDE });

export const H = 3_600_000;
export const inHours = (h) => new Date(Date.now() + h * H);

export async function makeListing({ quantity = 50, categoryId = 1, safeHours = 4, deadlineHours = 3 } = {}) {
  const donor = await user('restaurant@foodrescue.test');
  return createListing(donor, {
    categoryId,
    description: 'Test food',
    confirmedQuantity: quantity,
    preparedAt: new Date(Date.now() - 30 * 60_000),
    safeUntil: inHours(safeHours),
    collectionDeadline: inHours(deadlineHours),
    safetyConfirmed: true,
  });
}

export async function makeRequest({ quantity = 30, categoryId = 1, email = 'ngo@foodrescue.test', requiredHours = 5 } = {}) {
  const ngo = await user(email);
  return createRequest(ngo, { categoryId, requestedQuantity: quantity, requiredBy: inHours(requiredHours) });
}

/** Listing + request + proposed allocation + accepted (volunteer task OPEN). */
export async function acceptedScenario({ quantity = 20, selfCollect = false } = {}) {
  const listing = await makeListing({ quantity: 40 });
  const request = await makeRequest({ quantity });
  const allocation = await createAllocation({ listingId: listing.id, requestId: request.id, quantity });
  const accepted = await acceptAllocation(await user('ngo@foodrescue.test'), allocation.id, { selfCollect });
  return { listing, request, allocation: accepted, task: accepted.task };
}

/** acceptedScenario + claimed by volunteer@foodrescue.test */
export async function claimedScenario(opts) {
  const s = await acceptedScenario(opts);
  await claimTask(await user('volunteer@foodrescue.test'), s.task.id);
  const task = await prisma.rescueTask.findUnique({ where: { id: s.task.id } });
  return { ...s, task, pickupCode: deriveOtp(task.otpNonce, 'PICKUP'), deliveryCode: deriveOtp(task.otpNonce, 'DELIVERY') };
}

export { prisma };

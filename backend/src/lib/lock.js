// Concurrency-safe allocation (proposal: "Every operation that changes allocation
// state runs in a database transaction that first takes one PostgreSQL advisory
// lock, re-reads the rows, re-checks the rules and recomputes remaining quantity").
//
// Why one global lock instead of row locks? It is simple and provably safe: only one
// allocation-changing transaction runs at a time, so two NGOs (or two volunteers)
// can never both win the same food. The cost is that allocation writes are
// serialised, which is fine at campus / city-pilot scale (design trade-off, §12).
//
// pg_advisory_xact_lock is released automatically when the transaction commits or
// rolls back, so a crash can never leave the lock held. It also works through
// Neon's transaction-mode connection pooler.
import { prisma, TX_OPTIONS } from './prisma.js';

export const ALLOCATION_LOCK_KEY = 336005; // any constant bigint; "CSC336 team 5"

export async function takeAllocationLock(tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ALLOCATION_LOCK_KEY}::bigint)`;
}

/**
 * Run fn(tx) inside a transaction that holds the global allocation lock.
 * Everything fn reads after this point is guaranteed not to be changed by
 * another allocation write until fn finishes.
 */
export function withAllocationLock(fn) {
  return prisma.$transaction(async (tx) => {
    await takeAllocationLock(tx);
    return fn(tx);
  }, TX_OPTIONS);
}

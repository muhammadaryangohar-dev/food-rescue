// One shared Prisma client for the whole app.
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// Interactive-transaction settings. Neon is a remote database (~0.3 s per query
// from Pakistan), and locked transactions queue behind each other, so we allow far
// more than Prisma's 5-second default. `timeout` includes time spent waiting for
// the advisory lock. If it is ever exceeded, the transaction rolls back and the
// client gets "503 busy, try again" (nothing is half-written).
export const TX_OPTIONS = { maxWait: 30000, timeout: 60000 };

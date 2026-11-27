// Reads SystemConfig values with a short in-memory cache.
// Falls back to CONFIG_DEFAULTS if a key has not been stored yet.
//
// Inside a locked transaction ALWAYS pass `tx` as the db argument. Using the global
// client there would need a second pool connection while the first one holds the
// lock; under heavy concurrency the pool can run dry (we caught this in the
// 20-simultaneous-allocations test).
import { prisma } from './prisma.js';
import { CONFIG_DEFAULTS } from '../config/defaults.js';

const CACHE_MS = 30_000;
let cache = null;
let cachedAt = 0;

async function load(db = prisma) {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const rows = await db.systemConfig.findMany();
  const fresh = Object.fromEntries(Object.entries(CONFIG_DEFAULTS).map(([k, v]) => [k, v.value]));
  for (const row of rows) fresh[row.key] = row.value;
  cache = fresh;
  cachedAt = Date.now();
  return cache;
}

export function invalidateConfigCache() {
  cache = null;
}

export async function getConfig(key, db) {
  const all = await load(db);
  return all[key];
}

export async function getNumber(key, db) {
  const value = Number(await getConfig(key, db));
  if (Number.isNaN(value)) throw new Error(`Config ${key} is not a number`);
  return value;
}

/**
 * Synchronous read for views that cannot await: the cached value, or the default when
 * the cache is cold. Never use it for rules that must be exact (use getNumber).
 */
export function getCachedNumber(key) {
  const raw = cache?.[key] ?? CONFIG_DEFAULTS[key]?.value;
  return Number(raw);
}

export async function getAllConfig(db) {
  return { ...(await load(db)) };
}

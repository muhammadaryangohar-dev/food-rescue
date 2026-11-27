// Hand-off point between Member 1 (allocations) and Member 2 (matching engine).
//
// Allocation code calls triggerMatching(reason) whenever food or need becomes
// available: a listing or request is created, an offer is rejected / expires /
// is cancelled, or the expiry sweep releases food.
//
// MEMBER 2: register the real engine at start-up, e.g. in matching.service.js:
//
//   import { registerMatchingRunner } from './matching.trigger.js';
//   registerMatchingRunner(runMatching);
//
// The runner is called as   runner({ reason, tx, weights, dryRun })
//   - reason  : why the run started (string, for the decision log)
//   - tx      : OPTIONAL. If given, the caller already holds the allocation lock
//               inside this transaction: use it and do NOT open another lock.
//               If absent, open one with withAllocationLock() from src/lib/lock.js.
//   - weights : OPTIONAL { freshness, feasibility, quantityFit, proximity, fairness }
//               (percentages, sum 100). If given, use these instead of the
//               WEIGHT_* config values. Used by the weight-comparison dry run.
//   - dryRun  : true when called by the weight comparison. The caller rolls the
//               transaction back afterwards, so nothing is saved either way.
// Create each allocation with createAllocationLocked(tx, {...}) from
// src/modules/allocations/allocation.service.js. It re-checks every rule and the
// derived remaining quantities, so the engine can never over-allocate.

let runner = null;
let running = false;
let rerunRequested = false;
let paused = 0;

export function registerMatchingRunner(fn) {
  runner = fn;
}

export function hasMatchingRunner() {
  return typeof runner === 'function';
}

export function getMatchingRunner() {
  return runner;
}

/** Run the matching engine now and wait for the result (used by the admin "run matching" button). */
export async function runMatchingNow(reason = 'manual') {
  if (!runner) return { ran: false, message: 'Matching engine not installed yet (Member 2)' };
  return { ran: true, result: await runner({ reason }) };
}

/**
 * Pause automatic matching while fn runs (used by the concurrency demo so the
 * engine does not grab the demo's food). Manual runs are not affected.
 */
export async function withMatchingPaused(fn) {
  paused++;
  try {
    return await fn();
  } finally {
    paused--;
  }
}

/**
 * Fire-and-forget trigger. Never throws, never blocks the HTTP response.
 * If a run is already in progress, one more run is queued after it.
 */
export function triggerMatching(reason) {
  if (!runner || paused > 0 || process.env.MATCHING_AUTORUN === 'off') return;
  if (running) {
    rerunRequested = true;
    return;
  }
  running = true;
  setImmediate(async () => {
    try {
      await runner({ reason });
    } catch (err) {
      console.error('[matching] run failed:', err.message);
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        triggerMatching('queued');
      }
    }
  });
}

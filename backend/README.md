# FoodRescue back-end

The back-end is built with Node.js, Express 5, Prisma 6 and PostgreSQL. It is a modular monolith with one folder per module in `src/modules`.

## Setup (each teammate, once)

```bash
cd backend
npm install
copy .env.example .env        # then paste the Neon strings the team shared privately
npx prisma generate
npm run dev                   # http://localhost:5000/api/health
```

The tables already exist on the shared Neon database. **Only Member 1 runs migrations**: `npm run db:migrate -- --name what-changed`. Everyone else pulls and runs `npx prisma generate`.

| Command | What it does |
|---|---|
| `npm run dev` | starts the API with auto-reload |
| `npm run seed` | adds the Islamabad demo data: organisations and accounts (safe to repeat), plus food records, events, past rescues and open listings (only on an empty database). `-- --base-only` adds just the accounts |
| `npm run demo:reset -- --yes` | **wipes the whole database** and re-seeds it. Use before a demo only, and tell the team first |
| `npm run demo:concurrency -- --compare` | concurrency demo: shows the lock preventing over-allocation, and what happens without it |
| `npm test` | automated tests on a **local** test database (see below) |
| `npm run db:studio` | browse the data in your browser |

### Running the tests

The tests delete and recreate data, so they never touch Neon.

1. Create a local database once. In pgAdmin or psql run `CREATE DATABASE foodrescue_test;`
2. Run `copy .env.test.example .env.test` and put your local postgres password in it.
3. Run `npm test`. It applies the migrations to the test database, then runs 80 tests:

| File | What it covers |
|---|---|
| `allocation-lock` | 20 simultaneous allocations against one listing produce no over-allocation; also checks the allocation rules |
| `claim-race` | 6 volunteers claim the same task at once and exactly one wins; also no-show and approval rules |
| `sweep` | expiry of unanswered offers, uncollected food, stuck claims, late deliveries, listings and requests |
| `otp` | pickup and delivery codes, lock after 5 wrong codes, expiry, idempotent handovers, partial quantities, self-collect, quality rejection |
| `rules-and-api` | withdraw and edit rules, the database CHECK constraint, and HTTP auth, role, validation and 404 handling |
| `scope-change` | the Scope Change Note: only licensed restaurants and marquees/caterers donate (licence required, unique, not expired; expired licence blocks listing, allocation and admin approval; households refused), NGO type and beneficiaries, no re-offer after a rejection or expiry, listings always owned by the business, and the opt-in public NGO directory |
| `trips-reliability` | near-expiry alerts, combined pickup trips for pooled food (all-or-nothing claim), reliability scores, the NGO daily capacity across requests, and Pakistan-time licence expiry |
| `security` | changing the password logs out every other session (old tokens rejected, new token returned), a separate `OTP_SECRET` required in production, demo tools switched off in production |
| `extras` | live concurrency demo endpoint, "why wasn't I matched?", and the weight comparison saving nothing |

## Folder map

```
prisma/schema.prisma            all 19 tables (proposal section 14) + MatchDecision for the decision log
prisma/migrations/              *_init (all tables) and *_licensed_donors_ngo_directory (households removed, food licences, NGO contacts); hand-written CHECKs at the end of each
prisma/seed.js                  Islamabad demo seed (logic)
prisma/seed-data/islamabad.js   the dataset: restaurants, venues, marquees/caterers, NGOs, fictional volunteers
src/app.js, src/server.js       Express app and entry point
src/config/                     env validation, configurable defaults (SystemConfig)
src/lib/                        lock, derived quantities, OTP, history, notifications, privacy, haversine
src/middleware/                 auth (JWT, roles, verified), Zod validation, rate limits, error handler
src/modules/access/             M1  register (licensed donors only), login, profile, password
src/modules/listings/           M4  listings + categories
src/modules/matching/           M5  NGO requests (Member 1) + matching engine hook (Member 2)
src/modules/allocations/        M6  locked allocation transaction, accept/reject/cancel, expiry sweep
src/modules/location/           M8  area list (manual fallback), public NGO directory for households
src/modules/rescue/             M7  tasks, claim, OTP pickup/delivery, self-collect, quality rejection
src/modules/tracking/           M11 reports, timeline (via allocations)
src/modules/notifications-admin/ M12 notifications, admin controls, config panel, expiry simulation
scripts/                        demo-reset, concurrency-demo
tests/                          vitest suites
```

The API contract is in [docs/api/README.md](../docs/api/README.md). Diagrams are in [docs/diagrams](../docs/diagrams).

## Key design decisions (useful for the viva)

1. **One global PostgreSQL advisory lock** (`src/lib/lock.js`). Every write that changes allocation state, including create, accept, reject, cancel, claim, pickup, deliver, withdraw and sweep, runs in a transaction that first calls `pg_advisory_xact_lock`, then re-reads rows, re-checks the rules and recomputes quantities before writing. It is simple and provably safe; the cost is that these writes are serialised. `npm run demo:concurrency -- --compare` shows the difference: 50 of 50 servings allocated with the lock, 120 of 50 without it.
2. **Remaining quantity is derived, never stored** (`src/lib/quantities.js`). Rejected, expired and cancelled allocations release their food simply by no longer being counted, so no counter can drift.
3. **Expire-on-read, plus a one-minute timer** (`src/modules/allocations/sweep.service.js`). A one-query cheap check runs on reads (at most every 15 seconds) and once a minute from `server.js`. The full sweep runs under the lock only when something is overdue, and it also runs at the start of every allocation write, so an expired offer can never be accepted late even if the timer stops. The same sweep sends the one-time **near-expiry alert**.
4. **OTP codes are stored as hashes only.** The donor and NGO can still see their code because it is derived with an HMAC from a random per-task nonce. Wrong attempts are counted outside the rolled-back path, and 5 wrong attempts lock the task.
5. **Extras built on existing data:** pooled trips are derived from tasks grouped by request (`src/modules/rescue/trip.service.js`) and claimed all-or-nothing under the lock; reliability scores are calculated from `status_history` (`src/modules/tracking/reliability.service.js`). Neither adds a table, so neither can drift from the audit trail.
6. **Only licensed businesses donate.** A donor organisation must hold a food licence (database CHECK `chk_donor_org_licence`). `orgCanAct()` in `src/lib/access.js` treats an expired licence like an unverified account, so the business cannot list food and the allocation transaction refuses its listings. Changing the licence sends the business back to the admin. Households do not donate; `GET /api/ngos` shows them nearby NGOs that opted in to the public directory (`showInDirectory`), with only the contact the NGO chose to publish.
7. **Security hardening:** every token carries a password stamp (an HMAC of the current password hash, `src/middleware/auth.js`), so changing the password logs out every other device without a token table. In production the server refuses to start without a separate `OTP_SECRET` (32+ characters, not equal to `JWT_SECRET`), and the admin demo tools (concurrency demo, simulate expiry) and the `demo:reset` / `demo:concurrency` scripts are off unless `ENABLE_DEMO_TOOLS=true`.
8. **Privacy:** exact addresses and phone numbers are shown only to involved parties, only while a task is active (`src/lib/privacy.js`).
9. **Auditability:** every status change writes a `status_history` row, with a null actor when the system made the change. `GET /api/allocations/:id/timeline` shows the full story.

## For Member 2: plugging in the matching engine

The requests API, allocation transaction and sweep are finished. The engine connects through `src/modules/matching/matching.trigger.js`:

```js
// src/modules/matching/matching.service.js  (Member 2)
import { registerMatchingRunner } from './matching.trigger.js';
import { withAllocationLock } from '../../lib/lock.js';
import { createAllocationLocked } from '../allocations/allocation.service.js';
import { sweepLocked } from '../allocations/sweep.service.js';
import { listingQuantities, requestQuantities } from '../../lib/quantities.js';
import { getNumber } from '../../lib/config.js';
import { haversineKm } from '../../lib/haversine.js';

export async function runMatching({ reason, tx, weights }) {
  // `tx` is given by the weight comparison (already locked, rolled back afterwards):
  // use it and do NOT open a second lock. Normal runs open their own lock.
  if (tx) return match(tx, weights);
  return withAllocationLock((lockedTx) => match(lockedTx, weights));
}

async function match(tx, weightsOverride) {
  await sweepLocked(tx);
  const weights = weightsOverride ?? {
    freshness: await getNumber('WEIGHT_FRESHNESS', tx), feasibility: await getNumber('WEIGHT_FEASIBILITY', tx),
    quantityFit: await getNumber('WEIGHT_QUANTITY_FIT', tx), proximity: await getNumber('WEIGHT_PROXIMITY', tx),
    fairness: await getNumber('WEIGHT_FAIRNESS', tx),
  };
  // 1. load OPEN listings and requests; quantities via listingQuantities(tx, ...)
  // 2. stage 1 filters: record EVERY pair (feeds "why wasn't I matched?"):
  //    tx.matchDecision.create({ data: { runId, listingId, requestId, eligible: false,
  //      rejectionReason: 'estimated arrival 45 min is after the 30 min collection deadline' } })
  //    Write rejection reasons as plain sentences: the NGO sees them as-is.
  // 3. stage 2 scores (store eligible pairs too, with score + scoreBreakdown), greedy loop:
  await createAllocationLocked(tx, { listingId, requestId, quantity, score, scoreBreakdown, explanation });
  //    (it re-checks every rule and the remaining quantities, so it throws instead of over-allocating)
}
registerMatchingRunner(runMatching);
```

Once this is in place, two features start working with no further code:
- **`GET /api/requests/:id/match-decisions`** ("Why wasn't I matched?") reads the `match_decisions` rows the engine writes.
- **`POST /api/admin/matching/compare`** (weight comparison, CP3 evaluation) calls `runMatching({ tx, weights, dryRun: true })` once per weight set and always rolls back. This is why the engine must accept `tx` and `weights`. `tests/extras.test.js` has a tiny stand-in engine that shows the expected shape.

Then add `import './modules/matching/matching.service.js';` at the top of `src/app.js`. The runner is called automatically when a listing or request is created, when an offer is rejected, expires or is cancelled, and when the sweep releases food. An admin can also start it with `POST /api/admin/matching/run`. Inside the lock, always pass `tx` (for example `getNumber('WEIGHT_FRESHNESS', tx)`), never the global `prisma`.

To create a listing when an event's leftovers are confirmed, use `createListingTx(tx, user, data, { sourceType: 'EVENT', eventId })` from `src/modules/listings/listing.service.js`.

## Performance note

Neon is in Singapore. From a laptop in Pakistan each query takes about 0.3 to 1 s, so a locked write takes a few seconds in local development. This is network latency, not the code: the same writes take about 20 ms against a local database. For the live demo, deploy the back-end on Render in the **Singapore** region, next to Neon, or demo against local PostgreSQL.

# FoodRescue API contract

Base URL (local): `http://localhost:5000/api`

This file covers the Member 1 back-end: access, listings, requests, allocations, rescue, reports, notifications and admin. Matching, forecast, events, impact and fairness (Member 2) add their own sections here when they are built.

## Conventions

- **Auth:** send `Authorization: Bearer <token>`. You get the token from `/auth/register` or `/auth/login`. It expires after `JWT_EXPIRES_IN` (default 1 day).
- **Format:** JSON in and out. Dates are ISO 8601 strings, for example `2026-11-26T14:30:00.000Z`. Quantities are whole servings.
- **Errors:** every error has the same shape:
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "Enter a valid email address", "details": [{ "field": "email", "message": "..." }] } }
  ```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `BAD_REQUEST`, `WRONG_CODE`, `CONSTRAINT_VIOLATION` | Invalid input. For `WRONG_CODE`, `details.attemptsLeft` says how many tries remain |
| 401 | `UNAUTHORIZED` | Not logged in, or the token is invalid or expired |
| 403 | `FORBIDDEN` | Wrong role, not your record, account not verified, or account deactivated |
| 404 | `NOT_FOUND` | Record or route does not exist |
| 409 | `CONFLICT`, `DUPLICATE` | A business rule blocked it (not enough food left, already claimed, field locked...) |
| 410 | `EXPIRED` | The offer, task or code has expired |
| 423 | `LOCKED` | Rescue task locked after too many wrong codes; an admin must unlock it |
| 429 | `RATE_LIMITED` | Too many attempts (login: 10 failures per 15 min; codes: 20 per 10 min) |
| 503 | `BUSY` | Server busy. Nothing was saved, so retry |

- **Roles:** `DONOR` (with `donorType` `RESTAURANT` | `MARQUEE_CATERER`), `NGO`, `VOLUNTEER`, `ADMIN`. `MARQUEE_CATERER` covers marquees, caterers, banquet halls and hotels that cook for events.
- **Who donates:** only **licensed food businesses** (restaurants, and marquees / caterers). Each registers with its food licence (`licenceNumber`, `licenceAuthority`, `licenceExpiresOn`). **Households do not donate**: the front-end shows them the public [NGO directory](#ngo-directory-for-households) so they can contact an NGO directly.
- **Verification:** new organisations and volunteers start as `PENDING`. Until an admin verifies them they get `403` on create-listing, create-request, claim and similar actions. A donor business whose licence has expired is treated as unverified until it renews. `user.verified` in `/auth/me` tells the front-end which state the user is in.
- **Privacy:** before acceptance, and again after the task ends, listings come back with `address: null`, coordinates rounded to about 1 km, and `locationHidden: true`.
- **Expire-on-read:** any `GET` may expire overdue offers and listings first, and the server also checks once a minute. The front-end only needs to re-fetch.
- **Times:** all timestamps are UTC (ISO strings). "A day" (licence expiry dates, an NGO's daily capacity) is a calendar day in **Pakistan time** (UTC+5).
- **Urgency:** listings and tasks include `hoursLeft` and `nearExpiry` (true when less than `NEAR_EXPIRY_HOURS` remain before `safeUntil`). Show near-expiry items first and highlighted.

---

## Health

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `{ status, database: "up" \| "down", time }` |

## Auth (M1)

| Method | Path | Who | Body | Response |
|---|---|---|---|---|
| POST | `/auth/register` | anyone | see below | `201 { token, user }` |
| POST | `/auth/login` | anyone | `{ email, password }` | `{ token, user }` |
| GET | `/auth/me` | any user | | `{ user }` |
| PATCH | `/auth/me` | any user | `{ name?, phone?, organisation?, volunteer? }` | `{ user }` |
| POST | `/auth/change-password` | any user | `{ currentPassword, newPassword }` | `{ message, token }`. **Every older token (all devices) stops working**; the frontend must replace its stored token with this new one. A request with an old token gets 401 "Your password was changed. Please log in again" |

Passwords need at least 8 characters, including a letter and a number. Register bodies by role:

```jsonc
// Restaurant, or marquee / caterer (donorType "MARQUEE_CATERER"). The food licence is required.
{ "name": "Ali", "email": "ali@x.com", "password": "Secret123", "phone": "0300-1234567",
  "role": "DONOR", "donorType": "RESTAURANT",
  "organisation": { "name": "My Restaurant", "address": "Shop 12, Blue Area", "area": "Blue Area", "latitude": 33.71, "longitude": 73.05,
                    "licenceNumber": "IFA-12345", "licenceAuthority": "Islamabad Food Authority", "licenceExpiresOn": "2027-06-30",
                    "contactPhone": "051-1234567", "contactEmail": "info@myrestaurant.pk" } }
// licenceAuthority defaults to "Islamabad Food Authority"; licenceExpiresOn is optional but must not be in the past.
// The same authority + licence number cannot be registered twice (409).

// NGO. ngoType: FOOD_KITCHEN | ORPHANAGE | OLD_AGE_HOME | SHELTER | OTHER.
// beneficiaries = people served per day; dailyCapacity can be at most 3 servings per person (3 x beneficiaries).
// showInDirectory (default false) puts name, type, area, description and the public contact in the NGO directory;
// it needs contactPhone or contactEmail. NGO contacts are never copied from the personal account.
{ ..., "role": "NGO",
  "organisation": { "name": "My NGO", "address": "...", "area": "G-8", "latitude": 33.70, "longitude": 73.04,
                    "ngoType": "ORPHANAGE", "beneficiaries": 120, "dailyCapacity": 300, "serviceRadiusKm": 10,
                    "showInDirectory": true, "contactPhone": "051-7654321", "contactEmail": "help@myngo.org",
                    "description": "Home for 120 children in G-8; accepts cooked meals" } }

// Volunteer
{ ..., "role": "VOLUNTEER", "volunteer": { "availability": "Evenings", "serviceArea": "G-8" } }
```

`donorType: "HOUSEHOLD"` is refused with `400` and a message that points to the NGO directory.

`user` contains `id, name, email, phone, role, donorType, organisationId, active, organisation, volunteerProfile, verified`. It never contains the password hash.

**Profile edits:** a donor business that changes `licenceNumber`, `licenceAuthority` or `licenceExpiresOn` goes back to `PENDING` until an admin checks the new licence. Donor businesses cannot set NGO fields (`ngoType`, `dailyCapacity`, `beneficiaries`, `serviceRadiusKm`, `description`, `showInDirectory`) and NGOs cannot set licence fields (`400`). An NGO joins or leaves the directory with `PATCH /auth/me { organisation: { showInDirectory: true | false } }`.

**Manual area fallback:** `latitude` and `longitude` are optional everywhere. If the map does not load, send only an `area` from `GET /areas`. The server normalises the spelling (`"g-9"` becomes `"G-9"`) and fills in the area's centre coordinates. An area that isn't in the list is saved as typed, without coordinates, so a user is never blocked from registering.

## Areas (M8)

| Method | Path | Who | Response |
|---|---|---|---|
| GET | `/areas` | anyone (used on the register form) | `{ city: "Islamabad", areas: [{ name: "F-7", latitude, longitude }, ...] }`: 30 sectors and markets, for the area drop-down when the map fails |

## NGO directory for households

Public and read-only: no login needed. Households cannot donate on FoodRescue, so this page lets them find a nearby NGO and contact it directly. FoodRescue does not handle or track those donations (no listings, matching, OTP or impact counts).

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/ngos` | `area?` (from `GET /areas`), or `lat` + `lng` (map or browser location), `q?` (name search), `ngoType?` | `{ yourLocation, count, ngos: [{ id, name, ngoType, area, description, contactPhone, contactEmail, serviceRadiusKm, distanceKm, servesYourArea }], note, disclaimer }` |
| GET | `/ngos/:id` | | `{ ngo }` |

- **Opt-in (NFR8):** only **verified** NGOs that switched `showInDirectory` on, with at least one active account, are listed.
- Show the `disclaimer` on the page: "FoodRescue does not handle or verify these donations."
- With a location, NGOs whose service radius covers it come first (`servesYourArea: true`), each group nearest first. Without a location, `distanceKm` and `servesYourArea` are `null` and the list is alphabetical.
- An area that isn't in the area list filters by the NGO's own area instead.
- Only what the NGO chose to publish is shown: never its address, exact coordinates, staff accounts, capacity or rescue data. The distance is calculated on the server. Sending `lat` without `lng` returns `400`.

## Categories

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/categories` | anyone | → `{ categories: [{ id, name, defaultSafeHours }] }` |
| POST | `/categories` | ADMIN | `{ name, defaultSafeHours }` |
| PATCH | `/categories/:id` | ADMIN | `{ name?, defaultSafeHours? }` |

## Listings (M4)

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/listings` | verified DONOR | create; triggers matching |
| GET | `/listings?status=&categoryId=&area=` | DONOR → own listings; NGO and ADMIN → open food (default `status=OPEN`) | volunteers get 403 |
| GET | `/listings/:id` | owner, ADMIN, NGO; VOLUNTEER only for a task they hold | includes `allocations` (an NGO sees only its own) |
| PATCH | `/listings/:id` | owner or ADMIN | edit rules below |
| POST | `/listings/:id/withdraw` | owner or ADMIN | `{ reason? }` → `{ listingId, cancelledAllocations }` |

Create body:
```json
{ "categoryId": 1, "description": "Chicken karahi and naan", "confirmedQuantity": 40,
  "preparedAt": "...", "safeUntil": "...", "collectionDeadline": "...",
  "address": "optional, defaults to your profile", "area": "optional", "latitude": 33.7, "longitude": 73.0,
  "handlingNotes": "Keep warm", "dietaryInfo": "Halal", "safetyConfirmed": true,
  "eventId": 5 }
```
`eventId` is for a marquee / caterer listing leftovers from one of its own events (and they always list from an event). Every listing has `organisationId` (the donor business); event listings also have `eventId` and `sourceType: "EVENT"`. `donorName` reads e.g. "Park Road Banquet Hall (event: Walima)".

Rules:
- `safetyConfirmed` must be `true`.
- `collectionDeadline` must not be later than `safeUntil`, and both must be in the future.
- `safeUntil` can be at most `preparedAt` plus the category's `defaultSafeHours`.
- Once any allocation holds food from a listing, `categoryId`, `confirmedQuantity`, all times and the location are **locked** (`409` with `details.lockedFields`). Only `description`, `handlingNotes` and `dietaryInfo` can change. To change the rest, withdraw the listing and create a new one.
- Withdrawing cancels offers that are proposed or accepted. Food that is already picked up keeps going to its NGO.

Every listing includes `quantities: { confirmed, committed, remaining, delivered, lost, inProgress }`. These are **calculated, never stored**.

## NGO requests

| Method | Path | Who | Body |
|---|---|---|---|
| POST | `/requests` | verified NGO | `{ categoryId, requestedQuantity, requiredBy, notes? }`. All of an NGO's open and fulfilled requests needed on the same Pakistan day must add up to no more than its daily capacity (`400` with `details: { code: "DAILY_CAPACITY", alreadyRequested, dailyCapacity, remaining }`) |
| GET | `/requests?status=` | NGO → own; ADMIN → all | |
| GET | `/requests/:id` | owner or ADMIN | includes `allocations` |
| PATCH | `/requests/:id` | owner or ADMIN | once offers exist, `categoryId` and `requiredBy` are locked and the quantity cannot go below what is already covered. The daily capacity rule applies to the new values |
| POST | `/requests/:id/cancel` | owner or ADMIN | `{ reason? }`. Cancels offers that are not picked up yet. Refused (409) if food is already on its way |
| GET | `/requests/:id/match-decisions` | owner or ADMIN | **"Why wasn't I matched?"** See below |

`/requests/:id/match-decisions` shows the latest matching run that considered this request. The donor's address is never included.

```jsonc
{ "requestId": 12, "runId": "run-…", "runAt": "…", "remainingNeed": 20, "considered": 3, "eligible": 1,
  "decisions": [
    { "listing": { "id": 7, "description": "Biryani", "category": "Rice and biryani", "area": "Blue Area", "safeUntil": "…", "collectionDeadline": "…" },
      "eligible": false, "rejectionReason": "estimated arrival 45 min is after the 30 min collection deadline",
      "score": null, "scoreBreakdown": null, "offer": null,
      "summary": "Not offered: estimated arrival 45 min is after the 30 min collection deadline." },
    { "listing": { … }, "eligible": true, "score": 87.5,
      "scoreBreakdown": { "freshness": 27, "feasibility": 22, "quantityFit": 20, "proximity": 12, "fairness": 6.5 },
      "offer": { "status": "PROPOSED", "quantity": 20 }, "summary": "Offered 20 servings (score 87.5 / 100)." } ] }
```

Until the matching engine has run, the response is `decisions: []` with a `message`.

Requests include `quantities: { requested, covered, remainingNeed, delivered, inProgress }` and `reallocationPending`.

## Allocations / offers (M6)

Status flow: `PROPOSED → ACCEPTED → PICKED_UP → DELIVERED`. A `PROPOSED` offer can end as `REJECTED`, `EXPIRED` or `CANCELLED`. An `ACCEPTED` one can end as `CANCELLED` or `EXPIRED`. A `PICKED_UP` one can end as `FAILED`.

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/allocations?status=PROPOSED,ACCEPTED&requestId=&listingId=` | scoped by role | NGO → offers for its requests; DONOR → its listings; VOLUNTEER → its tasks; ADMIN → all |
| GET | `/allocations/:id` | involved parties, ADMIN | includes `score`, `scoreBreakdown`, `explanation`, `responseDeadline`, `pickupDeadline`, `decisionReason` |
| GET | `/allocations/:id/timeline` | involved parties, ADMIN | `{ timeline: [{ entity, entityId, from, to, reason, time, actor: { name, role } }] }`: every step of the allocation, its task, listing and request |
| POST | `/allocations/:id/accept` | owning NGO | `{ selfCollect: false }`. Creates the rescue task. `410` if the offer expired |
| POST | `/allocations/:id/reject` | owning NGO | `{ reason }` (min 3 chars). The food is released and the request is flagged for reallocation |
| POST | `/allocations/:id/cancel` | owning NGO or ADMIN | `{ reason? }`. Only before pickup |

**No re-offer loop:** once an NGO has rejected an offer of a listing, or let it expire, that same listing is never offered to that same request again (`409` with `details.code: "ALREADY_DECLINED"`). The food can still go to other NGOs. Cancelled offers do not count, because the NGO did not decline them.

## Rescue tasks (M7)

Task status: `OPEN` (waiting for a volunteer) → `CLAIMED` → `PICKED_UP` → `DELIVERED`. A task can also become `LOCKED` (too many wrong codes) or `CANCELLED`.

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/tasks/available` | verified VOLUNTEER | open volunteer tasks, **most urgent first** (address hidden until claimed) |
| GET | `/tasks/trips` | verified VOLUNTEER | **pooled trips**, see below |
| POST | `/tasks/trips/:requestId/claim` | verified VOLUNTEER | `{ taskIds }` exactly as shown in the trip. Claims all of them at once, or none (`409` with `details: { code: "TRIP_CHANGED", unavailable }`) |
| GET | `/tasks/trips/mine` | VOLUNTEER | my active trips with full stop details |
| GET | `/tasks/mine?status=` | any | VOLUNTEER → claimed by me; NGO → its tasks; DONOR → tasks on its listings; ADMIN → all (e.g. `?status=LOCKED`) |
| GET | `/tasks/:id` | involved parties, ADMIN; any volunteer while the task is OPEN | see the view below |
| POST | `/tasks/:id/claim` | verified VOLUNTEER | race-safe: exactly one volunteer wins, the rest get `409` |
| POST | `/tasks/:id/unclaim` | the claiming volunteer | task goes back to OPEN |
| POST | `/tasks/:id/pickup` | collector | `{ code: "123456", quantity }`. `quantity` can be less than allocated (partial) |
| POST | `/tasks/:id/deliver` | collector | `{ code, quantity }`. Only verified deliveries count as Rescued |
| POST | `/tasks/:id/reject-quality` | receiving NGO, ADMIN | `{ reason }`, after pickup. The allocation becomes FAILED and all of it counts as lost |

The **collector** is the claiming volunteer, or the NGO's own staff when `selfCollect` was true.

The task view includes:
- `yourRole`: `DONOR`, `NGO`, `COLLECTOR`, `ADMIN` or `null`
- `codes`: the donor sees `{ pickupCode }` (until pickup), the NGO sees `{ deliveryCode }`. The collector and admins see none, because the collector must be told the code in person at handover.
- `allocation.listing` and `allocation.request.ngo`: exact addresses only for involved parties while the task is active
- `contacts: { donor, ngo }`: names and phones, only while active
- `volunteer: { name, phone }`
- `distanceKm`: donor to NGO
- `handovers`

### Pooled trips (one volunteer, several donors, one NGO)

When the matching engine pools several donors to fill one request, each donor's food is its own task. A trip groups the open volunteer tasks for the same request so one volunteer can collect them in one run. It is derived, not stored.

```jsonc
{ "requestId": 4, "ngo": { "id": 9, "name": "Rizq", "area": "F-8" }, "taskIds": [12, 13],
  "totalServings": 80, "totalKm": 2.9, "totalMinutes": 7, "nearExpiry": false,
  "stops": [
    { "order": 1, "type": "PICKUP", "taskId": 12, "donorName": "Savour Foods", "area": "Blue Area", "servings": 50, "collectBy": "…", "legKm": 0, "hoursLeft": 4.9, "nearExpiry": false },
    { "order": 2, "type": "PICKUP", "taskId": 13, "donorName": "Kabul Restaurant", "area": "F-7", "servings": 30, "collectBy": "…", "legKm": 1.6, … },
    { "order": 3, "type": "DROPOFF", "ngoName": "Rizq", "area": "F-8", "legKm": 1.3 } ] }
```

- The route starts at the pickup farthest from the NGO, then always goes to the nearest next pickup, and ends at the NGO.
- Before claiming, stops show the area only. After claiming, `/tasks/trips/mine` gives each stop's full task view (address, contacts, codes for the right roles).
- Each later stop gets the travel time to reach it added to its claim window. Every pickup and delivery is still verified with its own codes.

Codes expire at the food's `safeUntil` time (`410`). Five wrong codes lock the task (`423`). Repeating a successful pickup or delivery returns `alreadyRecorded: true`, so the endpoints are idempotent.

## Reports (M11)

| Method | Path | Who | Body |
|---|---|---|---|
| POST | `/reports` | anyone involved in the allocation | `{ allocationId, type: NO_SHOW\|QUALITY\|QUANTITY_MISMATCH\|NOT_DELIVERED\|SAFETY\|OTHER, description }` |
| GET | `/reports?status=` | ADMIN → all; others → their own | |
| PATCH | `/admin/reports/:id/resolve` | ADMIN | `{ status: UPHELD\|DISMISSED, resolutionNote, reverseDelivery? }` |

When an upheld report uses `reverseDelivery: true`, a DELIVERED allocation becomes FAILED and stops counting as Rescued. An upheld `NO_SHOW` adds one to the volunteer's no-show count.

## Reliability score

| Method | Path | Who | Response |
|---|---|---|---|
| GET | `/reliability/me` | NGO, VOLUNTEER | own score |
| GET | `/admin/reliability?role=NGO\|VOLUNTEER` | ADMIN | `{ role, scores }`, lowest score first, `NEW` at the end |

Calculated from history the system already keeps; nothing extra is stored.
- **NGO:** `score = 100 × (accepted + 0.5 × rejected) / (accepted + rejected + unanswered)`. Rejecting frees food quickly, so it counts half; ignoring an offer until it expires counts zero. Response includes `offers: { accepted, rejected, unanswered }` and `servingsReceived`.
- **Volunteer:** `score = 100 × delivered / claimed − 10 per no-show − 15 per late delivery`, from 0 to 100. Response includes `tasks: { claimed, delivered, releasedByVolunteer, lateDeliveries, noShows }`.
- `level`: `EXCELLENT` (85+), `GOOD` (65+), `FAIR` (40+), `POOR`, or `NEW` with `score: null` when there are fewer than 3 answered offers or claims. Every row has a plain-language `explanation`.

## Notifications (M12)

Poll these endpoints, for example every 20 to 30 seconds.

| Method | Path | Response |
|---|---|---|
| GET | `/notifications?unread=true` | `{ notifications: [{ id, type, message, link, isRead, createdAt }] }` (latest 50). Urgent types: `NEAR_EXPIRY` (to NGOs within `NEAR_EXPIRY_RADIUS_KM` when unallocated food has less than `NEAR_EXPIRY_HOURS` left; once per listing) and `URGENT_PICKUP` (to volunteers in the area when a near-expiry pickup needs someone) |
| GET | `/notifications/unread-count` | `{ count }` |
| PATCH | `/notifications/:id/read` | `{ ok }` |
| POST | `/notifications/read-all` | `{ updated }` |

## Admin (M12), ADMIN only

| Method | Path | Body / notes |
|---|---|---|
| GET | `/admin/verifications?status=PENDING` | `{ organisations, volunteers }`. Donor businesses include their licence fields and `licenceExpired` |
| PATCH | `/admin/organisations/:id/verification` | `{ status: VERIFIED\|REJECTED\|PENDING }`. Approving a donor business with an expired licence returns `400` |
| PATCH | `/admin/volunteers/:id/verification` | same, plus `resetNoShows?` |
| GET | `/admin/users?role=&active=` | |
| PATCH | `/admin/users/:id/active` | `{ active: false }` deactivates the user; they are blocked on their next request |
| GET | `/admin/config` | `{ config: [{ key, value, default, description, updatedBy, updatedAt }] }` |
| PUT | `/admin/config/:key` | `{ value }`, for example `OFFER_RESPONSE_MINUTES` or `WEIGHT_FRESHNESS` |
| POST | `/admin/sweep` | runs the expiry sweep now → `{ sweep: { expiredOffers, expiredAccepted, releasedClaims, failedDeliveries, expiredListings, expiredRequests, nearExpiryAlerts } }` |
| GET | `/admin/reliability?role=NGO\|VOLUNTEER` | reliability scores (see [Reliability score](#reliability-score)) |
| POST | `/admin/matching/run` | runs Member 2's matching engine now |
| POST | `/admin/matching/compare` | **Weight comparison.** `{ weightSets: [{ name, weights: { freshness, feasibility, quantityFit, proximity, fairness } }] }`, 1 to 4 sets, each summing to 100. The engine runs once per set, plus once with the current settings, on real data, in a transaction that is **always rolled back**, so nothing is saved. Response: `{ savedAnything: false, results: [{ name, weights, allocations, totalServings, ngosServed, fairnessSpread, avgHoursToSafeUntil, avgScore, perNgo: [{ ngo, servings }], pairs }] }`. A lower `fairnessSpread` means food was shared more evenly; a lower `avgHoursToSafeUntil` means food closer to expiry was rescued first. Returns `501` until the engine is installed |
| POST | `/admin/demo/concurrency` | **Demo tool** (off in production unless `ENABLE_DEMO_TOOLS=true`; then 404 `DEMO_TOOLS_DISABLED`). **Live concurrency demo.** `{ attempts: 10, compare: false }` (2 to 30). Creates a demo listing of 50 servings and `attempts` requests of 10, fires every allocation at the same moment, then cleans up. Response: `{ scenario, withLock: { attempts, succeeded, refused, servingsAllocated, servingsConfirmed, overAllocated, durationMs, refusalReasons }, withoutLock? }`. `compare: true` adds the naive no-lock run, which shows over-allocation. Over Neon from a laptop each attempt takes a few seconds, so keep `attempts` low there |
| POST | `/admin/allocations` | `{ listingId, requestId, quantity, explanation? }`: manual allocation, with every rule checked under the lock |
| POST | `/admin/tasks/:id/unlock` | unlocks a task locked by wrong codes |
| POST | `/admin/simulate/expire` | **Demo tool** (off in production, like the concurrency demo). `{ allocationId? \| listingId? \| requestId? \| taskId? }`: moves that deadline into the past and runs the sweep (expiry demo) |

## Configuration keys (defaults)

| Key | Default | Used by |
|---|---|---|
| `OFFER_RESPONSE_MINUTES` | 30 | how long an NGO has to answer an offer |
| `PICKUP_WINDOW_MINUTES` | 120 | accepted food must be picked up within this time (capped by the collection deadline) |
| `CLAIM_WINDOW_MINUTES` | 45 | after this, a claimed but uncollected task is released |
| `OTP_MAX_ATTEMPTS` | 5 | wrong codes allowed before the task locks |
| `MIN_ALLOCATION_SERVINGS` | 5 | smallest allocation |
| `SWEEP_MIN_INTERVAL_SECONDS` | 15 | expire-on-read throttle |
| `VOLUNTEER_NO_SHOW_LIMIT` | 3 | no-shows allowed before a volunteer cannot claim |
| `NEAR_EXPIRY_HOURS`, `NEAR_EXPIRY_RADIUS_KM` | 2, 5 | near-expiry alert and `nearExpiry` flag; also the matching engine |
| `AVERAGE_SPEED_KMH` | 25 | pooled-trip time estimates; also the matching engine |
| `WEIGHT_*` | 30/25/20/15/10 | matching engine (Member 2) |

## Demo data and accounts (after `npm run seed` or `npm run demo:reset -- --yes`)

The seed fills the database with a realistic Islamabad dataset:
- 35 restaurants (33 verified; 2 pending, one of them, Cafe Aylanto, with an **expired licence** so the admin cannot approve it), including 14th Street Pizza (Bahria Town) and Hot & Chilli (DHA)
- 27 marquees / caterers (24 verified): hotels and venues, real marquees in **E-11** (Monal, Aura Grande, Taj, Margalla Grande, Paradise), on the **Islamabad Expressway** (Fortress, Empire, Montreal, Royal) and in **Bahria Town** (Rubaish), plus generic invented names in Bahria Town, Bahria Enclave, **DHA Phase 2**, G-13 and I-9
- every donor business has a fictional food licence (`IFA-DEMO-R001`... for restaurants, `IFA-DEMO-M001`... for marquees / caterers), valid for a year
- 27 NGOs (25 verified) with a type and beneficiaries (food kitchens, shelters, orphanages, old-age homes), covering the sectors plus Bahria, DHA and the Expressway; 22 of the verified ones opted in to the public NGO directory (Akhuwat, Red Crescent and Barkat Street Kitchen did not, to show the opt-in rule), each with a fictional public contact number
- 15 volunteers (no household accounts: households use the NGO directory), including E-11, Bahria Town and DHA
- 14 food categories: cooked meals, rice and biryani, bread and bakery, dairy, fruit and vegetables, sweets and desserts, packaged food, fast food, barbecue and kababs, lentils and vegetable dishes, pizza and pasta, salads and raita, breakfast items, drinks and juices
- menus: every restaurant has 4 to 5 items for its style; every marquee / caterer has a 9-item wedding menu (biryani, qorma, tikka and kababs, naan, sabzi, salad and raita, zarda and kheer, fruit, drinks)
- 4 weeks of restaurant food records (about 4,200 rows)
- 5 events: a past one, a just-finished one, an upcoming hotel conference, an upcoming marquee wedding and a Mehndi night at Monal Marquee (E-11)
- a ready-to-claim **pooled trip**: Rizq's 80-serving rice request filled by Savour Foods (50) and Kabul Restaurant (30), both accepted
- 2 weeks of past rescues (30 delivered, 3 failed, 2 expired)
- 16 open listings (one near expiry; including Bahria Town and DHA) and 12 open NGO requests

> **Academic demo data.** Organisation names are real Islamabad restaurants, hotels and NGOs, used only to make this university project demo realistic. None of them is affiliated with FoodRescue, and every listing, request and rescue is simulated. Locations are approximate (sector or market level). A few organisations have generic invented names (marked in the seed file) placed in real areas. All people, licence numbers and phone numbers (including the NGO numbers in the directory) are fictional, not the real organisations' details. The full list is in `backend/prisma/seed-data/islamabad.js`.

Every account uses the password `Password123`.

| Email | Role | Belongs to |
|---|---|---|
| admin@foodrescue.test | ADMIN | |
| restaurant@foodrescue.test | DONOR (restaurant, verified) | Savour Foods, Blue Area |
| events@foodrescue.test | DONOR (marquee / caterer, verified) | Serena Hotel Islamabad |
| caterer@foodrescue.test | DONOR (marquee / caterer, verified) | Park Road Banquet Hall, Park Road |
| ngo@foodrescue.test | NGO (verified) | Rizq |
| ngo2@foodrescue.test | NGO (verified) | Robin Hood Army Islamabad |
| ngo-pending@foodrescue.test | NGO (pending) | Al-Khidmat Foundation Islamabad |
| volunteer@foodrescue.test | VOLUNTEER (approved, any area) | Hassan Raza |
| volunteer2@foodrescue.test | VOLUNTEER (approved, F-7) | Areeba Khan |
| volunteer-pending@foodrescue.test | VOLUNTEER (pending) | Saim Javed |

Every other organisation and volunteer also has a login, `<slug>@foodrescue.test`, for example `kabul-restaurant@`, `edhi-foundation@`, `islamabad-club@` or `maryam-tahir@`. Run `GET /admin/users` to see them all.

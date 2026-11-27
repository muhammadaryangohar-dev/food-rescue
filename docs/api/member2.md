# Member 2 API: matching, forecast and prevention, events, impact, fairness

Owner: Fatima Niazi (FA24-BCS-116). Base address `http://localhost:5000/api`. Every route needs `Authorization: Bearer <token>`. Errors use the same format as the rest of the API (`docs/api/README.md`).

## Matching engine (M5)

There are no new routes. The engine is `backend/src/modules/matching/matching.service.js`, registered through `matching.trigger.js`. It runs automatically when a listing or request is created, an offer is rejected, expires or is cancelled, the sweep releases food, or event leftovers are confirmed. Admins can run it with `POST /admin/matching/run` and compare weights with `POST /admin/matching/compare`.

How one run works:

1. **Stage 1, hard rules** (`matching.rules.js`, `checkPair`): same category; donor verified with a valid licence; NGO verified; not already rejected or expired for this NGO; enough food left (minimum offer `MIN_ALLOCATION_SERVINGS`); inside the NGO's service radius (Haversine); near-expiry rule (under `NEAR_EXPIRY_HOURS` left, only NGOs within `NEAR_EXPIRY_RADIUS_KM`); a pickup is still possible before the collection deadline; estimated arrival before safe-until and before the required-by time (worst case: the NGO uses its whole `OFFER_RESPONSE_MINUTES`, then 15 minutes to set off, then travel at `AVERAGE_SPEED_KMH`); NGO daily capacity left. A failed pair gets one plain-English reason.
2. **Stage 2, score out of 100** (`scorePair`), with weights from `WEIGHT_*` (scaled to add up to 100 if an admin saved weights that don't):
   - Freshness: rescue-first, so food with less of its safe life left scores higher.
   - Feasibility: minutes of slack before the tightest deadline; full points at 120 minutes or more.
   - Quantity fit: share of the remaining need this offer covers.
   - Proximity: 1 minus distance divided by service radius.
   - Fairness: 1 minus what the NGO received in the last 7 days divided by what the most-served NGO received.
3. **Greedy loop with pooling**: take the best pair. On equal scores, the food that expires sooner goes first. Offer `min(food left, need left, capacity left)` through `createAllocationLocked`, update the numbers, re-score, and repeat. **At most 8 offers per run** (`MAX_OFFERS_PER_RUN`): on Neon each offer takes a few seconds inside the lock, so when the cap is hit (`more: true`) another run is queued for the rest.
4. Every pair considered is written to `match_decisions`. `GET /requests/:id/match-decisions` reads these rows. Rows older than 24 hours are deleted at the start of each run.

**Never re-offered** (`declinedPairs` in `allocations/allocation.service.js`, shared with manual offers): pairs the NGO rejected, cancelled itself, or never answered while proposed. An offer that expired after the NGO accepted it (for example a volunteer no-show), or one cancelled by an admin or a withdrawing donor, does not block the NGO.

## Forecast and prevention (M2): `/food` (restaurants; admins read with `?organisationId=`)

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/food/items` | | Menu items (restaurants and marquees) |
| POST | `/food/items` | `{ name, categoryId }` | Add a menu item |
| GET | `/food/forecast` | `?date=YYYY-MM-DD` (default today) | Forecast per item, the weeks it used, that day's record and warning |
| POST | `/food/records/plan` | `{ foodItemId, date, planned }` | Today or up to 7 days ahead. Saves the forecast shown. **Plan and forecast shown are then locked** (409 `PLAN_LOCKED`) |
| PATCH | `/food/records/actuals` | `{ foodItemId, date, prepared?, sold?, wasted?, wasteReason?, soldOut? }` | On or after the day, up to 2 days later. Wasted defaults to prepared minus sold |
| GET | `/food/records` | `?from&to&foodItemId` | Records with `warning`, `prevented`, `wasteRatio` |
| GET | `/food/summary` | `?days=28` | Totals, per item, per week. `donated` = rescued servings of food prepared that day; `netWasted = wasted − donated`; the waste ratio uses `netWasted` |

- Forecast: weighted average of sold on the same weekday over the last 4 weeks, weights 4/3/2/1 (newest first). Sold-out days are left out when at least 2 other weeks remain. With fewer than 2 weeks of history there is no forecast.
- Potential surplus: `max(0, planned − forecast)`. The warning level is HIGH at 20% or more.
- Prevented: `max(0, min(planned − prepared, planned − forecastShown))`, capped at half the forecast shown. It is 0 when no forecast was shown.
- Why the cap: without it, an absurd plan (say 1,000 against a forecast of 100, then cooking 100) would claim 900 servings prevented. Credit is limited to half the forecast, so a plan more than 50% above the forecast earns no extra credit.

## Events (M3): `/events` (marquees / caterers; admins read all)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/events` | `?status=` | Own events, with `estimate` |
| GET | `/events/:id` | | Includes food plans and listings created |
| POST | `/events` | `{ name, date, venue, expectedGuests, servingsPerGuest?, plans: [{ foodItemId, plannedServings }] }` | |
| PATCH | `/events/:id` | Any of the fields above | Only while PLANNED. `plans` replaces the whole plan |
| POST | `/events/:id/complete` | `{ prepared?: [{ foodItemId, preparedServings }] }` | PLANNED → COMPLETED, only after the event has started. `prepared` = what was actually cooked per dish |
| POST | `/events/:id/leftovers` | `{ safetyConfirmed: true, prepared?: [...], leftovers: [{ categoryId, description, quantity, preparedAt?, safeUntil?, collectionDeadline?, handlingNotes?, dietaryInfo? }] }` | Each leftover becomes an EVENT listing in one transaction, then matching runs. `[]` means no leftovers. Total leftovers cannot exceed what was cooked (or planned, if cooked amounts weren't entered). Event → CONFIRMED |

- `estimate`: `neededServings = ceil(guests × servingsPerGuest)`, `plannedServings`, `overPlanned`, and a `warning`.
- Leftover defaults: prepared at the event time; safe for the category's default hours; collection closes 1 hour before safe-until.
- **Marquee Prevented (no new database columns):** when a *future* event's food plan is first saved, each dish is written as a `DailyFoodRecord` on the event's date: `planned` = planned servings, `forecastShown` = the dish's share of the estimate. The cooked amount (`prepared`) comes with `/complete` or `/leftovers`, and the restaurant Prevented formula then applies. Once saved, the records don't change, and the event's date can no longer change (409). Each event returns `prevention`: `{ recorded, estimateShown, plannedAtEstimate, prepared, prevented, dishes }`. Limitation: one record per dish per day, so if one marquee holds two events on the same day, only the first counts.

## Impact (M9): `GET /impact/summary`

Query: `days` (default 30), `scope=all|mine` (donors and NGOs get their own numbers), `interval=day|week`.

Returns:
- `totals`: `prevented` with `preventedBreakdown` (`restaurants`, `marquees`), `rescued` (OTP-verified deliveries only), `lost` with `lostBreakdown` (`lostInTransit`, `expiredUnclaimed`), `shortfallAtPickup` (donor handed over less than offered; shown separately, not counted as Lost), `listed`, `rescueRate`, `wasteRatio` (rescued restaurant food is subtracted from waste).
- `trend`: one row per day or week with prevented, rescued, lost and waste ratio, ready for a Recharts line chart.
- `topDonors` and `byNgoType`.

## Fairness (M10): `GET /fairness` (admins and NGOs)

Query: `days` (default 7). For each verified NGO, least-served first, it returns:
- received servings, share %, servings per person served
- food still on its way
- the fairness points the engine would give it now
- Member 1's reliability score

Platform summary: `gini` (0 = even), most and least received, and totals by NGO type.

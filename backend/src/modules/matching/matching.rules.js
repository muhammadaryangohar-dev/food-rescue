// Matching engine rules (M5, Member 2). Pure functions: plain objects in, a result out,
// no database calls, so every rule can be unit-tested on its own.
//
// Stage 1 (checkPair): hard pass / fail rules. A pair that fails gets ONE plain-English
// reason, written for the NGO to read as-is ("Why wasn't I matched?").
// Stage 2 (scorePair): an explainable score out of 100, made of five parts:
//   freshness 30, collection feasibility 25, quantity fit 20, proximity 15, fairness 10
// (default weights; admins change them in SystemConfig).
import { haversineKm, travelMinutes } from '../../lib/haversine.js';
import { orgCanAct } from '../../lib/access.js';
import { pkDateLabel, pkTimeLabel } from '../../lib/time.js';

export const WEIGHT_NAMES = ['freshness', 'feasibility', 'quantityFit', 'proximity', 'fairness'];

// Minutes the collector needs to set off once the NGO has accepted. Added to the NGO's
// response window (OFFER_RESPONSE_MINUTES) for the arrival estimate.
export const PICKUP_LEAD_MINUTES = 15;
// Slack (minutes before the earliest deadline) that earns full feasibility points.
export const FULL_SLACK_MINUTES = 120;
// Service radius assumed when an NGO has not set one.
export const DEFAULT_RADIUS_KM = 15;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const MIN = 60_000;
const HOUR = 3_600_000;

/** "1 h 20 min" / "45 min" */
export function durationLabel(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const km1 = (km) => `${Math.round(km * 10) / 10} km`;

/**
 * Stage 1: can this listing go to this request at all?
 * ctx: { now, cfg: { minAllocation, nearExpiryHours, nearExpiryKm, speedKmh, responseMinutes },
 *        remaining, remainingNeed, capacityLeft (null = no limit), declined (bool) }
 * Returns { ok: true, km, pickupAt, arriveAt, hoursLeft } or { ok: false, reason }.
 */
export function checkPair(listing, request, ctx) {
  const { now, cfg } = ctx;
  const ngo = request.ngo;
  const fail = (reason) => ({ ok: false, reason });

  if (listing.categoryId !== request.categoryId) {
    return fail(`this food is ${listing.category?.name ?? 'a different category'}, but the request is for ${request.category?.name ?? 'another category'}`);
  }
  if (!orgCanAct(listing.organisation, now)) return fail('the donor business is not verified or its food licence has expired');
  if (!orgCanAct(ngo, now)) return fail('the NGO is not verified yet');
  if (ctx.declined) return fail('the NGO already rejected or did not answer an offer of this food, so it is not offered again');

  const minQ = Math.min(cfg.minAllocation, ctx.remainingNeed);
  if (ctx.remaining < minQ) return fail(`only ${ctx.remaining} servings are left on this listing, below the minimum offer of ${minQ}`);

  const km = haversineKm(listing.latitude, listing.longitude, ngo.latitude, ngo.longitude);
  if (km === null) return fail('the donor or NGO location is missing, so the distance cannot be checked');
  const radius = ngo.serviceRadiusKm ?? DEFAULT_RADIUS_KM;
  if (km > radius) return fail(`the food is ${km1(km)} away, outside the NGO's ${radius} km service radius`);

  const hoursLeft = (listing.safeUntil - now) / HOUR;
  if (hoursLeft < cfg.nearExpiryHours && km > cfg.nearExpiryKm) {
    return fail(`only ${durationLabel(hoursLeft * 60)} of safe time is left, so only NGOs within ${cfg.nearExpiryKm} km qualify, and this one is ${km1(km)} away`);
  }

  // Worst case: the NGO takes its whole response window to accept, then the collector
  // needs PICKUP_LEAD_MINUTES to set off.
  const pickupAt = new Date(now.getTime() + ((cfg.responseMinutes ?? 0) + PICKUP_LEAD_MINUTES) * MIN);
  const arriveAt = new Date(pickupAt.getTime() + travelMinutes(km, cfg.speedKmh) * MIN);
  if (pickupAt > listing.collectionDeadline) {
    return fail(`collection closes at ${pkTimeLabel(listing.collectionDeadline)}, too soon to arrange a pickup`);
  }
  if (arriveAt > listing.safeUntil) {
    return fail(`the food would arrive at about ${pkTimeLabel(arriveAt)}, after it stops being safe at ${pkTimeLabel(listing.safeUntil)}`);
  }
  if (arriveAt > request.requiredBy) {
    return fail(`the estimated arrival at ${pkTimeLabel(arriveAt)} is after the required-by time of ${pkTimeLabel(request.requiredBy)}`);
  }

  if (ctx.capacityLeft !== null && ctx.capacityLeft < minQ) {
    return fail(`the NGO's daily capacity for ${pkDateLabel(request.requiredBy)} is already used up`);
  }

  return { ok: true, km, pickupAt, arriveAt, hoursLeft };
}

/** How many servings this pair would move right now. */
export function giveQuantity(ctx) {
  const cap = ctx.capacityLeft === null ? Infinity : ctx.capacityLeft;
  return Math.max(0, Math.min(ctx.remaining, ctx.remainingNeed, cap));
}

/**
 * Stage 2: score out of 100.
 * check: the ok result of checkPair. ctx adds { weights, received, maxReceived }.
 * Returns { score, breakdown, give } where breakdown[part] = { value (0-1), points }.
 */
export function scorePair(listing, request, check, ctx) {
  const { now, weights } = ctx;
  const give = giveQuantity(ctx);

  // Freshness, rescue-first (team review: "score food that is close to expiry higher").
  // Every pair here already passed the safety rules, so the food is safe; among safe
  // food, the one with less of its safe life left is rescued first.
  const lifeMs = Math.max(listing.safeUntil - listing.preparedAt, HOUR);
  const leftMs = Math.max(listing.safeUntil - now, 0);
  const freshness = clamp01(1 - leftMs / lifeMs);

  // Collection feasibility: minutes of slack before the tightest deadline (pickup before
  // the collection deadline; arrival before safe-until and the required-by time).
  const pickupSlack = (listing.collectionDeadline - check.pickupAt) / MIN;
  const arrivalSlack = (Math.min(+listing.safeUntil, +request.requiredBy) - check.arriveAt) / MIN;
  const slackMin = Math.min(pickupSlack, arrivalSlack);
  const feasibility = clamp01(slackMin / FULL_SLACK_MINUTES);

  const quantityFit = ctx.remainingNeed > 0 ? clamp01(give / ctx.remainingNeed) : 0;
  const radius = request.ngo.serviceRadiusKm ?? DEFAULT_RADIUS_KM;
  const proximity = clamp01(1 - check.km / radius);
  // Fairness: NGOs that received less in the last 7 days score higher.
  const fairness = ctx.maxReceived > 0 ? clamp01(1 - (ctx.received || 0) / ctx.maxReceived) : 1;

  const values = { freshness, feasibility, quantityFit, proximity, fairness };
  const breakdown = {};
  let score = 0;
  for (const name of WEIGHT_NAMES) {
    const points = Math.round(values[name] * (weights[name] ?? 0) * 10) / 10;
    breakdown[name] = { value: Math.round(values[name] * 100) / 100, points, weight: weights[name] ?? 0 };
    score += points;
  }
  breakdown.distanceKm = Math.round(check.km * 10) / 10;
  breakdown.slackMinutes = Math.round(slackMin);
  return { score: Math.round(score * 10) / 10, breakdown, give };
}

const PART_TEXT = {
  freshness: () => 'the food needs rescuing soon',
  feasibility: (b) => `there is ${durationLabel(b.slackMinutes)} of slack before the deadline`,
  quantityFit: () => 'it covers a large part of the request',
  proximity: (b) => `it is only ${km1(b.distanceKm)} away`,
  fairness: () => 'this NGO has received less food recently',
};

/** Plain-language explanation stored on the allocation (NFR7). */
export function explain(score, breakdown, quantity, need) {
  const top = WEIGHT_NAMES.filter((n) => breakdown[n].weight > 0)
    .sort((a, b) => breakdown[b].points / breakdown[b].weight - breakdown[a].points / breakdown[a].weight)
    .slice(0, 2)
    .map((n) => PART_TEXT[n](breakdown));
  return `Offered ${quantity} of ${need} needed servings (score ${score}/100, ${km1(breakdown.distanceKm)} away) because ${top.join(' and ')}.`;
}

/** Order for the greedy loop: highest score; ties go to the food that expires sooner, then the earlier need. */
export function comparePairs(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (+a.listing.safeUntil !== +b.listing.safeUntil) return a.listing.safeUntil - b.listing.safeUntil;
  if (+a.request.requiredBy !== +b.request.requiredBy) return a.request.requiredBy - b.request.requiredBy;
  return a.listing.id - b.listing.id || a.request.id - b.request.id;
}

// Track A, Prevention (M2, Member 2): weekday demand forecast and prevention maths.
// Pure functions, no database, so they are easy to test and explain in the viva.
//
// Forecast: weighted average of SOLD quantity on the same weekday over the last 4 weeks,
// newest week weight 4, then 3, 2, 1. Example (oldest -> newest 80, 90, 100, 110):
//   (80x1 + 90x2 + 100x3 + 110x4) / 10 = 100
// Sold-out days understate demand (the restaurant ran out), so they are left out when at
// least MIN_WEEKS other weeks remain. With too little history no forecast is shown.

export const LOOKBACK_WEEKS = 4;
export const MIN_WEEKS = 2;
// A plan more than 50% above the forecast is treated as unrealistic: prevention credit is
// capped at half the forecast, so an inflated plan cannot inflate the Prevented counter.
export const PREVENTED_CAP_RATIO = 0.5;

const DAY_MS = 24 * 3_600_000;

/** The same weekday 1..4 weeks before `date` (date-only UTC midnight values), newest first. */
export function lookbackDates(date) {
  return Array.from({ length: LOOKBACK_WEEKS }, (_, i) => new Date(date.getTime() - (i + 1) * 7 * DAY_MS));
}

/**
 * history: records for the lookback dates, any order: [{ date, sold, soldOut }]
 * Returns { forecast (int or null), basedOn: [{ date, sold, soldOut, weight, used }], note }.
 */
export function weekdayForecast(date, history) {
  const byDate = new Map(history.map((r) => [new Date(r.date).getTime(), r]));
  const weeks = lookbackDates(date)
    .map((d, i) => ({ date: d, weight: LOOKBACK_WEEKS - i, record: byDate.get(d.getTime()) }))
    .filter((w) => w.record && w.record.sold !== null && w.record.sold !== undefined);

  const clean = weeks.filter((w) => !w.record.soldOut);
  const use = clean.length >= MIN_WEEKS ? clean : weeks;
  const basedOn = weeks.map((w) => ({ date: w.date, sold: w.record.sold, soldOut: w.record.soldOut, weight: w.weight, used: use.includes(w) }));

  if (use.length < MIN_WEEKS) {
    return { forecast: null, basedOn, note: `Not enough history: needs sales for this weekday in at least ${MIN_WEEKS} of the last ${LOOKBACK_WEEKS} weeks.` };
  }
  const wSum = use.reduce((s, w) => s + w.weight, 0);
  const forecast = Math.round(use.reduce((s, w) => s + w.record.sold * w.weight, 0) / wSum);
  const skipped = weeks.length - use.length;
  return { forecast, basedOn, note: skipped ? `${skipped} sold-out day(s) left out because they understate demand.` : null };
}

/** Potential surplus = max(0, planned - forecast). */
export function potentialSurplus(planned, forecast) {
  if (forecast === null || forecast === undefined || planned === null || planned === undefined) return 0;
  return Math.max(0, planned - forecast);
}

/** Warning shown when the plan is above the forecast. */
export function surplusWarning(planned, forecast) {
  const surplus = potentialSurplus(planned, forecast);
  if (surplus <= 0) return null;
  const pct = forecast > 0 ? Math.round((surplus / forecast) * 100) : 100;
  return {
    potentialSurplus: surplus,
    percentAboveForecast: pct,
    level: pct >= 20 ? 'HIGH' : 'LOW',
    message: `You plan ${planned} but the forecast is ${forecast}: about ${surplus} servings (${pct}%) may be left over. Consider preparing closer to ${forecast}.`,
  };
}

/**
 * Prevented = max(0, min(planned - prepared, planned - forecastShown)), capped at
 * PREVENTED_CAP_RATIO x forecastShown. A restaurant can never claim more prevention than
 * the warning justified, and no credit is given without a forecast that was shown.
 */
export function preventedServings({ planned, prepared, forecastShown }) {
  if (forecastShown === null || forecastShown === undefined || prepared === null || prepared === undefined) return 0;
  const raw = Math.max(0, Math.min(planned - prepared, planned - forecastShown));
  return Math.min(raw, Math.ceil(forecastShown * PREVENTED_CAP_RATIO));
}

/** Waste ratio = wasted / prepared (null when nothing was prepared). */
export function wasteRatio(wasted, prepared) {
  if (!prepared) return null;
  return Math.round((wasted / prepared) * 1000) / 1000;
}

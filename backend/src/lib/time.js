// Pakistan time helpers. All timestamps are stored in UTC, but "a day" for FoodRescue
// (licence expiry dates, an NGO's daily capacity) is a calendar day in Pakistan.
// Pakistan Standard Time is UTC+5 all year (no daylight saving), so a fixed offset is exact.
export const PK_OFFSET_MS = 5 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/** Today's date in Pakistan, as a date-only value (UTC midnight), comparable with @db.Date columns. */
export function pkToday(now = new Date()) {
  const d = new Date(now.getTime() + PK_OFFSET_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** The instant the Pakistan calendar day containing `at` starts, and ends (exclusive). */
export function pkDayRange(at) {
  const start = new Date(pkToday(at).getTime() - PK_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** A date-only value (e.g. licence expiry) stays valid until the end of that day in Pakistan. */
export function endOfPkDate(dateOnly) {
  const d = new Date(dateOnly);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + DAY_MS - PK_OFFSET_MS);
}

/** "27 Nov" style label in Pakistan time, for messages. */
export function pkDateLabel(at) {
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Karachi' });
}

/** "21:30" style label in Pakistan time, for messages. */
export function pkTimeLabel(at) {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' });
}

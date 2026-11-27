// Great-circle distance between two points (M8). Calculated on the server, so no
// external map service is ever called during matching or allocation (NFR9).
const R_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v === null || v === undefined)) return null;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}

/** Travel-time estimate in minutes at a given average speed. */
export function travelMinutes(distanceKm, speedKmh = 25) {
  if (distanceKm === null) return null;
  return (distanceKm / speedKmh) * 60;
}

// Islamabad areas for the manual area fallback (FR7, NFR9): "Users set locations by
// choosing a point on a map, with manual area selection as a fallback."
// If the map does not load, the user picks an area from this list and the server
// fills in the area's approximate centre, so distance checks still work.
// Coordinates are approximate centres of each sector / market (good to ~1 km).

export const ISLAMABAD_AREAS = [
  // F sectors
  { name: 'F-5', latitude: 33.7300, longitude: 73.0950 },
  { name: 'F-6', latitude: 33.7295, longitude: 73.0770 },
  { name: 'Kohsar Market (F-6/3)', latitude: 33.7345, longitude: 73.0790 },
  { name: 'F-7', latitude: 33.7205, longitude: 73.0560 },
  { name: 'F-8', latitude: 33.7090, longitude: 73.0370 },
  { name: 'Centaurus (F-8/4)', latitude: 33.7075, longitude: 73.0500 },
  { name: 'F-9 Park', latitude: 33.7030, longitude: 73.0235 },
  { name: 'F-10', latitude: 33.6955, longitude: 73.0130 },
  { name: 'F-11', latitude: 33.6840, longitude: 72.9880 },
  // E sectors
  { name: 'E-7', latitude: 33.7300, longitude: 73.0480 },
  { name: 'E-11', latitude: 33.6990, longitude: 72.9740 },
  // G sectors
  { name: 'G-5', latitude: 33.7200, longitude: 73.1000 },
  { name: 'G-6', latitude: 33.7055, longitude: 73.0840 },
  { name: 'G-7', latitude: 33.6985, longitude: 73.0705 },
  { name: 'G-8', latitude: 33.6935, longitude: 73.0490 },
  { name: 'G-9', latitude: 33.6880, longitude: 73.0310 },
  { name: 'G-10', latitude: 33.6770, longitude: 73.0135 },
  { name: 'G-11', latitude: 33.6680, longitude: 72.9955 },
  { name: 'G-13', latitude: 33.6500, longitude: 72.9700 },
  // H and I sectors
  { name: 'H-8', latitude: 33.6800, longitude: 73.0650 },
  { name: 'I-8', latitude: 33.6680, longitude: 73.0760 },
  { name: 'I-9', latitude: 33.6540, longitude: 73.0570 },
  { name: 'I-10', latitude: 33.6490, longitude: 73.0365 },
  // Central / other
  { name: 'Blue Area', latitude: 33.7110, longitude: 73.0600 },
  { name: 'Saidpur Village', latitude: 33.7445, longitude: 73.0665 },
  { name: 'Shakarparian', latitude: 33.6925, longitude: 73.0980 },
  { name: 'Murree Road', latitude: 33.7090, longitude: 73.1060 },
  { name: 'Rawal Lake', latitude: 33.7110, longitude: 73.1300 },
  { name: 'Park Road (Chak Shahzad)', latitude: 33.6690, longitude: 73.1350 },
  { name: 'DHA Phase 2', latitude: 33.5300, longitude: 73.1550 },
  { name: 'Islamabad Expressway', latitude: 33.6250, longitude: 73.1230 },
  { name: 'Bahria Town Phase 7', latitude: 33.5255, longitude: 73.0985 },
  { name: 'Bahria Enclave', latitude: 33.7010, longitude: 73.1870 },
];

const byName = new Map(ISLAMABAD_AREAS.map((a) => [a.name.toLowerCase(), a]));

/** Find a known area by name (case-insensitive). Returns null for unknown areas. */
export function findArea(name) {
  if (!name) return null;
  return byName.get(String(name).trim().toLowerCase()) || null;
}

/**
 * Normalise a location: use the canonical area name if it is known, and fill
 * missing coordinates from the area's centre. Unknown areas are kept as typed
 * (with no coordinates) so a user is never blocked from registering.
 */
export function withAreaFallback(loc) {
  if (!loc) return loc;
  const area = findArea(loc.area);
  if (!area) return loc;
  const hasPoint = loc.latitude !== undefined && loc.latitude !== null && loc.longitude !== undefined && loc.longitude !== null;
  return {
    ...loc,
    area: area.name,
    latitude: hasPoint ? loc.latitude : area.latitude,
    longitude: hasPoint ? loc.longitude : area.longitude,
  };
}

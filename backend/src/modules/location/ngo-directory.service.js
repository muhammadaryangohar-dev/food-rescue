// Public NGO directory (scope change: households no longer donate on FoodRescue).
// A household opens the directory without an account, picks its area or shares its
// location, and sees NGOs it can contact and donate to itself. FoodRescue does not
// handle, track or verify those donations: no listings, matching, OTP or impact counts.
//
// Opt-in only (NFR8): an NGO appears only when it switched showInDirectory on, and the
// page shows only its name, type, area, description and the contact it chose to make
// public. Never its address, exact coordinates, staff accounts or rescue data. Distance
// is calculated on the server and only the rounded number is returned.
import { prisma } from '../../lib/prisma.js';
import { haversineKm } from '../../lib/haversine.js';
import { findArea } from '../../lib/areas.js';
import { notFound } from '../../lib/errors.js';

export const DIRECTORY_DISCLAIMER = 'FoodRescue does not handle or verify these donations.';
const NOTE =
  'FoodRescue only collects surplus food from licensed restaurants, marquees and caterers. If you have food to give from home, you can contact one of these NGOs directly.';

const SELECT = {
  id: true,
  name: true,
  ngoType: true,
  area: true,
  description: true,
  contactPhone: true,
  contactEmail: true,
  serviceRadiusKm: true,
  latitude: true, // used for the distance only, never returned
  longitude: true,
};

// Verified NGOs that opted in and still have at least one active account
const LISTED = { type: 'NGO', verificationStatus: 'VERIFIED', showInDirectory: true, users: { some: { active: true } } };

const round1 = (n) => Math.round(n * 10) / 10;

function publicEntry({ latitude, longitude, ...ngo }, from) {
  const km = from ? haversineKm(from.latitude, from.longitude, latitude, longitude) : null;
  return {
    ...ngo,
    distanceKm: km === null ? null : round1(km),
    // Does the NGO usually serve this location? (null when we do not know where the household is)
    servesYourArea: km === null || ngo.serviceRadiusKm == null ? null : km <= ngo.serviceRadiusKm,
  };
}

/**
 * List NGOs. The household's location comes from lat/lng (map or browser location)
 * or, as the manual fallback, from an Islamabad area name.
 */
export async function listNgos({ q, area, lat, lng, ngoType }) {
  const where = { ...LISTED };
  if (q) where.name = { contains: q, mode: 'insensitive' };
  if (ngoType) where.ngoType = ngoType;

  const known = area ? findArea(area) : null;
  const from = lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : known;

  const rows = await prisma.organisation.findMany({ where, select: SELECT, orderBy: { name: 'asc' } });
  let ngos = rows.map((n) => publicEntry(n, from));

  // An unknown area name (no coordinates) filters by the NGO's own area instead
  if (area && !from) ngos = ngos.filter((n) => n.area.toLowerCase() === area.trim().toLowerCase());
  if (from) {
    ngos.sort((a, b) => {
      if (a.servesYourArea !== b.servesYourArea) return a.servesYourArea ? -1 : 1;
      return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
    });
  }

  return {
    yourLocation: from ? { area: known?.name ?? null } : null,
    count: ngos.length,
    ngos,
    note: NOTE,
    disclaimer: DIRECTORY_DISCLAIMER,
  };
}

export async function getNgo(id) {
  const ngo = await prisma.organisation.findFirst({ where: { id, ...LISTED }, select: SELECT });
  if (!ngo) throw notFound('NGO');
  return { ...publicEntry(ngo, null), disclaimer: DIRECTORY_DISCLAIMER };
}

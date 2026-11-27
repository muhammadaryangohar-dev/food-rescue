// Address privacy (NFR8): "exact addresses and phone numbers are hidden until an
// allocation is accepted and hidden again when the task ends".
//
// Who sees the exact pickup address of a listing?
//   - the donor who owns it, and admins: always
//   - the NGO of an allocation that is ACCEPTED or PICKED_UP on that listing
//   - the volunteer holding a CLAIMED or PICKED_UP task on that listing
// Everyone else sees only the area and coordinates rounded to ~1 km.
import { ownsListing } from './access.js';

const ACTIVE_ALLOC = ['ACCEPTED', 'PICKED_UP'];
const ACTIVE_TASK = ['CLAIMED', 'PICKED_UP', 'LOCKED'];

export async function canSeeExactListing(tx, user, listing) {
  if (user.role === 'ADMIN' || ownsListing(user, listing)) return true;
  if (user.role === 'NGO') {
    const hit = await tx.allocation.findFirst({
      where: { listingId: listing.id, status: { in: ACTIVE_ALLOC }, request: { ngoId: user.organisationId } },
      select: { id: true },
    });
    return !!hit;
  }
  if (user.role === 'VOLUNTEER' && user.volunteerProfile) {
    const hit = await tx.rescueTask.findFirst({
      where: { volunteerId: user.volunteerProfile.id, status: { in: ACTIVE_TASK }, allocation: { listingId: listing.id } },
      select: { id: true },
    });
    return !!hit;
  }
  return false;
}

const round2 = (v) => (v === null || v === undefined ? v : Math.round(v * 100) / 100);

/** Hide exact location fields unless `exact` is true. */
export function maskLocation(obj, exact) {
  if (exact) return { ...obj, locationHidden: false };
  return { ...obj, address: null, latitude: round2(obj.latitude), longitude: round2(obj.longitude), locationHidden: true };
}

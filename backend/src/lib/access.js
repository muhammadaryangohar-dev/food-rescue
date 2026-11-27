import { endOfPkDate } from './time.js';

// Ownership and verification helpers (FR1, FR2, NFR2: "role and ownership checks on
// every route"; "Unverified users cannot list, request or collect food").

/**
 * Has a donor business's food licence expired? The licence is valid until the end of
 * its expiry date in Pakistan time. (No expiry date recorded = not expired.)
 */
export function licenceExpired(org, now = new Date()) {
  if (!org?.licenceExpiresOn) return false;
  return now >= endOfPkDate(org.licenceExpiresOn);
}

/**
 * Can this organisation act? NGOs: verified. Donor businesses: verified AND their
 * food licence is still valid (only licensed restaurants and marquees/caterers donate).
 */
export function orgCanAct(org, now = new Date()) {
  if (!org || org.verificationStatus !== 'VERIFIED') return false;
  return org.type === 'NGO' || !licenceExpired(org, now);
}

/** Is this user (loaded with organisation/volunteerProfile) verified? */
export function isVerified(user) {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'VOLUNTEER') return user.volunteerProfile?.approvalStatus === 'VERIFIED';
  return orgCanAct(user.organisation);
}

/** Does the user act for the donor business of this listing? (Every listing has one.) */
export function ownsListing(user, listing) {
  return user.role === 'DONOR' && !!user.organisationId && user.organisationId === listing.organisationId;
}

/** Does the user act for the NGO that made this request? */
export function ownsRequest(user, request) {
  return user.role === 'NGO' && user.organisationId === request.ngoId;
}

/** Is the user the collector of this task (assigned volunteer, or NGO staff for self-collect)? */
export function isCollector(user, task, request) {
  if (task.collectorType === 'VOLUNTEER') return user.role === 'VOLUNTEER' && !!task.volunteerId && user.volunteerProfile?.id === task.volunteerId;
  return ownsRequest(user, request);
}

/** Strip secrets before sending a user to the client. */
export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

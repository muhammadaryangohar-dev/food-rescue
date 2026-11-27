// Authentication and authorisation middleware (M1, NFR2).
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { isVerified } from '../lib/access.js';

export const USER_INCLUDE = { organisation: true, volunteerProfile: true };

/**
 * Password stamp: a short HMAC of the user's current password hash. It goes into every
 * token, so changing the password changes the stamp and every older token (on any
 * device) stops working. It reveals nothing about the hash and needs no extra column.
 */
export function passwordStamp(user) {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(`pw:${user.id}:${user.passwordHash}`).digest('base64url').slice(0, 22);
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, pws: passwordStamp(user) }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}

/**
 * Requires a valid "Authorization: Bearer <token>" header. The user is re-loaded
 * from the database on every request, so a deactivated user is blocked
 * immediately (active-user check), even if their token has not expired yet.
 */
export async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Session expired, please log in again' : 'Invalid token');
  }

  const user = await prisma.user.findUnique({ where: { id: Number(payload.sub) }, include: USER_INCLUDE });
  if (!user) throw unauthorized('Account no longer exists');
  // Tokens issued before the last password change (or without a stamp) are rejected
  if (payload.pws !== passwordStamp(user)) throw unauthorized('Your password was changed. Please log in again');
  if (!user.active) throw forbidden('Your account has been deactivated');
  req.user = user;
  next();
}

/** Allow only the given roles, e.g. requireRole('NGO', 'ADMIN'). */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.user.role)) throw forbidden(`Only ${roles.join(' / ')} users can do this`);
    next();
  };
}

/** Block unverified organisations (or donors with an expired food licence) and volunteers (FR2). */
export function requireVerified(req, _res, next) {
  if (!isVerified(req.user)) throw forbidden('Your account is waiting for admin verification');
  next();
}

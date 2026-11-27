// One-time pickup and delivery codes (proposal: "Separate pickup and delivery codes,
// visible only to the donor and the NGO, expire at the food's safe-until time and
// lock after repeated wrong attempts").
//
// How it works:
//  - Each task gets a random nonce. The 6-digit code is HMAC(OTP_SECRET, nonce:type),
//    so the server can show it again to the donor/NGO without storing it in plain text.
//  - Only a SHA-256 hash of each code is stored in the database (pickup_otp_hash,
//    delivery_otp_hash). A database leak therefore does not reveal usable codes.
//  - Verification compares hashes with a constant-time comparison.
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export const newNonce = () => crypto.randomBytes(16).toString('hex');

// Called everywhere as deriveOtp(nonce, type). The HMAC input keeps the exact string
// the first version produced ("<nonce>:<type>:undefined"), so codes for tasks that are
// already open stay valid.
export function deriveOtp(nonce, type) {
  const mac = crypto.createHmac('sha256', env.OTP_SECRET).update(`${nonce}:${type}:undefined`).digest();
  const n = mac.readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

export const hashOtp = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

export function otpMatches(code, storedHash) {
  const a = Buffer.from(hashOtp(code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

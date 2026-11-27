// Rate limiting on login and OTP endpoints (NFR2).
import rateLimit from 'express-rate-limit';

const isTest = process.env.NODE_ENV === 'test';
const message = (text) => ({ error: { code: 'RATE_LIMITED', message: text } });

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 1000 : 10,
  skipSuccessfulRequests: true, // only failed attempts count (brute-force protection)
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many failed attempts. Try again in 15 minutes.'),
});

export const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: isTest ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many code attempts. Try again later.'),
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: isTest ? 100000 : 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Too many requests. Slow down a little.'),
});

// Loads and validates environment variables once, at start-up.
// If something required is missing the server refuses to start with a clear message.
import 'dotenv/config';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(5000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
    JWT_EXPIRES_IN: z.string().default('1d'),
    CLIENT_URL: z.string().default('http://localhost:5173'),
    // Secret used to derive the one-time pickup/delivery codes. It must be separate from
    // JWT_SECRET in production, so a leaked JWT secret cannot also forge handover codes.
    OTP_SECRET: z.string().optional(),
    // Admin demo tools (live concurrency demo, "simulate expiry"). On by default in
    // development and test, OFF by default in production. Set "true" to show them on a demo server.
    ENABLE_DEMO_TOOLS: z.enum(['true', 'false']).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV !== 'production') return;
    if (!e.OTP_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['OTP_SECRET'], message: 'OTP_SECRET is required in production (a separate long random string)' });
    } else if (e.OTP_SECRET.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['OTP_SECRET'], message: 'OTP_SECRET must be at least 32 characters in production' });
    } else if (e.OTP_SECRET === e.JWT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['OTP_SECRET'], message: 'OTP_SECRET must be different from JWT_SECRET' });
    }
  });

/** Validates a set of variables. Exported so the rules can be tested without exiting. */
export function parseEnv(source) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const d = parsed.data;
  return {
    ok: true,
    // Development fallback only: production refuses to start without its own OTP_SECRET.
    usingOtpFallback: !d.OTP_SECRET,
    env: {
      ...d,
      OTP_SECRET: d.OTP_SECRET || d.JWT_SECRET,
      demoTools: d.ENABLE_DEMO_TOOLS ? d.ENABLE_DEMO_TOOLS === 'true' : d.NODE_ENV !== 'production',
    },
  };
}

const result = parseEnv(process.env);
if (!result.ok) {
  console.error('Invalid environment configuration:');
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (result.usingOtpFallback && result.env.NODE_ENV === 'development') {
  console.warn('Warning: OTP_SECRET is not set, so pickup/delivery codes use JWT_SECRET. Set a separate OTP_SECRET before deploying.');
}

export const env = result.env;

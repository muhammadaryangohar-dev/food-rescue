// Security hardening: logout-everywhere on password change, a separate OTP secret
// in production, and demo tools switched off in production.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { resetDb, prisma } from './helpers.js';
import { createApp } from '../src/app.js';
import { env, parseEnv } from '../src/config/env.js';

const app = createApp();
const login = async (email, password = 'Password123') => (await request(app).post('/api/auth/login').send({ email, password })).body.token;
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const me = (token) => request(app).get('/api/auth/me').set(auth(token));

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

describe('changing the password logs out every other session', () => {
  it('old tokens stop working, the new token from change-password works, and the new password logs in', async () => {
    const phone = await login('volunteer2@foodrescue.test');
    const laptop = await login('volunteer2@foodrescue.test');
    expect((await me(phone)).status).toBe(200);

    const changed = await request(app).post('/api/auth/change-password').set(auth(laptop)).send({ currentPassword: 'Password123', newPassword: 'NewSecret456' });
    expect(changed.status).toBe(200);
    expect(changed.body.token).toBeTruthy();

    for (const old of [phone, laptop]) {
      const res = await me(old);
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/password was changed/i);
    }
    expect((await me(changed.body.token)).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email: 'volunteer2@foodrescue.test', password: 'Password123' })).status).toBe(401);
    expect(await login('volunteer2@foodrescue.test', 'NewSecret456')).toBeTruthy();
  });

  it('rejects a correctly signed token without a password stamp (issued before this rule)', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'ngo@foodrescue.test' } });
    const legacy = jwt.sign({ sub: u.id, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
    expect((await me(legacy)).status).toBe(401);
  });
});

describe('OTP secret rules', () => {
  const base = { DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'j'.repeat(40) };

  it('production refuses to start without a separate, long OTP_SECRET', () => {
    expect(parseEnv({ ...base, NODE_ENV: 'production' }).errors.join()).toMatch(/OTP_SECRET is required/);
    expect(parseEnv({ ...base, NODE_ENV: 'production', OTP_SECRET: 'short' }).errors.join()).toMatch(/at least 32/);
    expect(parseEnv({ ...base, NODE_ENV: 'production', OTP_SECRET: base.JWT_SECRET }).errors.join()).toMatch(/different from JWT_SECRET/);
    const ok = parseEnv({ ...base, NODE_ENV: 'production', OTP_SECRET: 'o'.repeat(40) });
    expect(ok.ok).toBe(true);
    expect(ok.env.OTP_SECRET).toBe('o'.repeat(40));
  });

  it('development still works without one (falls back, with a warning)', () => {
    const dev = parseEnv({ ...base, NODE_ENV: 'development' });
    expect(dev.ok).toBe(true);
    expect(dev.usingOtpFallback).toBe(true);
    expect(dev.env.OTP_SECRET).toBe(base.JWT_SECRET);
  });
});

describe('demo tools are off in production', () => {
  const original = env.demoTools;
  afterEach(() => {
    env.demoTools = original;
  });

  it('defaults: on in development and test, off in production unless ENABLE_DEMO_TOOLS=true', () => {
    const base = { DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'j'.repeat(40), OTP_SECRET: 'o'.repeat(40) };
    expect(parseEnv({ ...base, NODE_ENV: 'development' }).env.demoTools).toBe(true);
    expect(parseEnv({ ...base, NODE_ENV: 'production' }).env.demoTools).toBe(false);
    expect(parseEnv({ ...base, NODE_ENV: 'production', ENABLE_DEMO_TOOLS: 'true' }).env.demoTools).toBe(true);
    expect(parseEnv({ ...base, NODE_ENV: 'development', ENABLE_DEMO_TOOLS: 'false' }).env.demoTools).toBe(false);
  });

  it('when switched off, the concurrency demo and simulate-expiry return 404 and change nothing', async () => {
    const admin = await login('admin@foodrescue.test');
    env.demoTools = false;
    const before = await prisma.surplusListing.count();
    const demo = await request(app).post('/api/admin/demo/concurrency').set(auth(admin)).send({ attempts: 4 });
    expect(demo.status).toBe(404);
    expect(demo.body.error.code).toBe('DEMO_TOOLS_DISABLED');
    expect((await request(app).post('/api/admin/simulate/expire').set(auth(admin)).send({ listingId: 1 })).status).toBe(404);
    expect(await prisma.surplusListing.count()).toBe(before);
    // ordinary admin features keep working
    expect((await request(app).get('/api/admin/config').set(auth(admin))).status).toBe(200);
  });
});

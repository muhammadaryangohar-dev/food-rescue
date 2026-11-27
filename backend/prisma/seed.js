// FoodRescue seed: realistic Islamabad demo data.
//
//   npm run seed                 base data + demo activity (activity only if the DB has no listings yet)
//   npm run seed -- --base-only  only categories, config, organisations and accounts
//   npm run demo:reset -- --yes  wipe everything, then full seed
//
// ACADEMIC DEMO DATA: organisation names are real Islamabad businesses/NGOs used
// only for a university project demo; they are not affiliated with FoodRescue and all
// activity is simulated. All people, licence numbers and phone numbers are fictional.
// See prisma/seed-data/islamabad.js.
//
// Donors are licensed businesses only (restaurants, marquees / caterers / venues).
// Households do not donate; they use the public NGO directory (GET /api/ngos).
//
// Every account uses the password: Password123
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { CONFIG_DEFAULTS } from '../src/config/defaults.js';
import { findArea } from '../src/lib/areas.js';
import { newNonce, deriveOtp, hashOtp } from '../src/lib/otp.js';
import { RESTAURANTS, EXPIRED_LICENCE, MARQUEES_CATERERS, NGOS, MANAGER_NAMES, VOLUNTEERS, MENUS, DEMO_LOGINS } from './seed-data/islamabad.js';

const prisma = new PrismaClient();
const PASSWORD = 'Password123';
const DOMAIN = 'foodrescue.test';
const HOUR = 3_600_000;
const MIN = 60_000;

// Order matters: ids 1..14 on a fresh database (tests use id 1 = Cooked meals).
// Add new categories at the END so existing ids never change.
const CATEGORIES = [
  { name: 'Cooked meals', defaultSafeHours: 6 },
  { name: 'Rice and biryani', defaultSafeHours: 6 },
  { name: 'Bread and bakery', defaultSafeHours: 24 },
  { name: 'Dairy', defaultSafeHours: 12 },
  { name: 'Fruit and vegetables', defaultSafeHours: 48 },
  { name: 'Sweets and desserts', defaultSafeHours: 24 },
  { name: 'Packaged food', defaultSafeHours: 72 },
  { name: 'Fast food', defaultSafeHours: 6 },
  { name: 'Barbecue and kababs', defaultSafeHours: 6 },
  { name: 'Lentils and vegetable dishes', defaultSafeHours: 6 },
  { name: 'Pizza and pasta', defaultSafeHours: 6 },
  { name: 'Salads and raita', defaultSafeHours: 4 },
  { name: 'Breakfast items', defaultSafeHours: 6 },
  { name: 'Drinks and juices', defaultSafeHours: 24 },
];

// ---------------------------------------------------------------- helpers

/** Deterministic pseudo-random numbers, so every seed run produces the same data. */
function rng(seedText) {
  let h = 2166136261;
  for (const c of String(seedText)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const phone = (n) => `0300-00${String(n).padStart(5, '0')}`; // reserved-looking fake range

/** Area centre plus a small fixed offset per organisation, so map pins do not stack. */
function locate(area, key) {
  const a = findArea(area);
  if (!a) throw new Error(`Unknown area in seed data: ${area}`);
  const r = rng(key);
  return { area: a.name, latitude: +(a.latitude + (r() - 0.5) * 0.004).toFixed(6), longitude: +(a.longitude + (r() - 0.5) * 0.004).toFixed(6) };
}

const LICENCE_AUTHORITY = 'Islamabad Food Authority';

/**
 * Fictional food licence: valid for a year, or expired 20 days ago for EXPIRED_LICENCE.
 * Restaurants are IFA-DEMO-R001..., marquees / caterers IFA-DEMO-M001..., in list order,
 * so adding a restaurant never renumbers (and collides with) a marquee's licence.
 */
function licenceFor(slug, prefix, n) {
  const expires = new Date();
  expires.setUTCHours(0, 0, 0, 0);
  expires.setUTCDate(expires.getUTCDate() + (EXPIRED_LICENCE.includes(slug) ? -20 : 365));
  return { licenceNumber: `IFA-DEMO-${prefix}${String(n).padStart(3, '0')}`, licenceAuthority: LICENCE_AUTHORITY, licenceExpiresOn: expires };
}

function emailFor(key) {
  const alias = Object.entries(DEMO_LOGINS).find(([, target]) => target === key)?.[0];
  return `${alias || slugify(key)}@${DOMAIN}`;
}

// ---------------------------------------------------------------- base data

async function upsertOrg(client, data) {
  const existing = await client.organisation.findFirst({ where: { name: data.name } });
  if (existing) return client.organisation.update({ where: { id: existing.id }, data });
  return client.organisation.create({ data });
}

async function upsertUser(client, { email, ...data }) {
  return client.user.upsert({ where: { email }, update: { name: data.name, phone: data.phone, role: data.role, donorType: data.donorType ?? null, organisationId: data.organisationId ?? null }, create: { email, ...data } });
}

async function seedBase(client, passwordHash) {
  for (const c of CATEGORIES) await client.foodCategory.upsert({ where: { name: c.name }, update: { defaultSafeHours: c.defaultSafeHours }, create: c });
  for (const [key, { value, description }] of Object.entries(CONFIG_DEFAULTS)) {
    await client.systemConfig.upsert({ where: { key }, update: { description }, create: { key, value, description } });
  }

  await upsertUser(client, { email: `admin@${DOMAIN}`, name: 'Platform Admin', role: 'ADMIN', passwordHash, phone: phone(1) });

  const orgs = {}; // slug -> organisation (with type)
  let n = 0;
  const managerFor = async (slug, org, role, donorType) => {
    const name = MANAGER_NAMES[n % MANAGER_NAMES.length];
    n++;
    const user = await upsertUser(client, { email: emailFor(slug), name, role, donorType, organisationId: org.id, passwordHash, phone: phone(100 + n) });
    orgs[slug] = { ...org, managerId: user.id };
  };

  let restaurantNo = 0;
  let marqueeNo = 0;
  const contact = (slug) => ({ contactPhone: phone(200 + n), contactEmail: emailFor(slug) });
  for (const [slug, name, area, address, status, menu] of RESTAURANTS) {
    const org = await upsertOrg(client, { name, type: 'RESTAURANT', address, ...locate(area, slug), ...licenceFor(slug, 'R', ++restaurantNo), ...contact(slug), verificationStatus: status, dailyCapacity: null, serviceRadiusKm: null });
    await managerFor(slug, { ...org, menu }, 'DONOR', 'RESTAURANT');
  }
  for (const [slug, name, area, address, status] of MARQUEES_CATERERS) {
    const org = await upsertOrg(client, { name, type: 'MARQUEE_CATERER', address, ...locate(area, slug), ...licenceFor(slug, 'M', ++marqueeNo), ...contact(slug), verificationStatus: status, dailyCapacity: null, serviceRadiusKm: null });
    await managerFor(slug, { ...org, menu: 'marquee' }, 'DONOR', 'MARQUEE_CATERER');
  }
  for (const [slug, name, area, address, status, capacity, radius, ngoType, beneficiaries, showInDirectory] of NGOS) {
    const description = `Collects surplus cooked food from licensed restaurants and caterers and serves meals to people in need around ${findArea(area).name} (up to about ${radius} km).`;
    const org = await upsertOrg(client, { name, type: 'NGO', ngoType, beneficiaries, showInDirectory, address, ...locate(area, slug), ...contact(slug), description, verificationStatus: status, dailyCapacity: capacity, serviceRadiusKm: radius });
    await managerFor(slug, org, 'NGO', null);
  }

  const volunteers = [];
  for (const [i, [name, availability, serviceArea, status, noShows]] of VOLUNTEERS.entries()) {
    const user = await upsertUser(client, { email: emailFor(name), name, role: 'VOLUNTEER', passwordHash, phone: phone(500 + i) });
    const profile = { availability, serviceArea: serviceArea ? findArea(serviceArea).name : null, approvalStatus: status, noShowCount: noShows };
    volunteers.push({ ...(await client.volunteerProfile.upsert({ where: { userId: user.id }, update: profile, create: { userId: user.id, ...profile } })), name });
  }

  return { orgs, volunteers };
}

// ---------------------------------------------------------------- demo activity

const WEEKDAY_FACTOR = [1.2, 0.85, 0.9, 0.95, 1.0, 1.25, 1.3]; // Sun..Sat (Fri/Sat busiest)

async function seedFoodRecords(client, orgs, categoryByName) {
  let records = 0;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (const org of Object.values(orgs)) {
    if (!org.menu || org.verificationStatus !== 'VERIFIED') continue;
    for (const [itemName, catName, base] of MENUS[org.menu]) {
      const item = await client.foodItem.upsert({
        where: { organisationId_name: { organisationId: org.id, name: itemName } },
        update: {},
        create: { organisationId: org.id, name: itemName, categoryId: categoryByName[catName].id },
      });
      if (org.type !== 'RESTAURANT') continue; // events plan per event, no daily records
      const r = rng(`${org.name}:${itemName}`);
      const rows = [];
      for (let d = 28; d >= 1; d--) {
        const date = new Date(today.getTime() - d * 24 * HOUR);
        let sold = Math.round(base * WEEKDAY_FACTOR[date.getUTCDay()] * (0.88 + r() * 0.24));
        const planned = Math.round(sold * (1.08 + r() * 0.14));
        const prepared = planned - Math.round(r() * 0.06 * planned);
        const soldOut = r() < 0.07;
        if (soldOut || sold > prepared) sold = prepared;
        const wasted = Math.max(0, prepared - sold);
        rows.push({ foodItemId: item.id, date, planned, prepared, sold, wasted, soldOut, wasteReason: wasted > prepared * 0.1 ? 'Over-prepared for expected demand' : null });
      }
      const { count } = await client.dailyFoodRecord.createMany({ data: rows, skipDuplicates: true });
      records += count;
    }
  }
  return records;
}

async function seedEvents(client, orgs) {
  const plan = async (org, data, servings) => {
    const items = await client.foodItem.findMany({ where: { organisationId: org.id } });
    const event = await client.event.create({ data: { organisationId: org.id, ...data } });
    await client.eventFoodPlan.createMany({ data: items.map((it, i) => ({ eventId: event.id, foodItemId: it.id, plannedServings: servings[i % servings.length] })) });
    await client.statusHistory.create({ data: { entity: 'EVENT', entityId: event.id, toStatus: data.status, reason: 'Seed data', time: data.date } });
    return event;
  };
  const now = Date.now();
  const past = await plan(orgs['serena-hotel'], { name: 'Corporate Annual Dinner', date: new Date(now - 3 * 24 * HOUR), venue: 'Serena Hotel Islamabad, Grand Ballroom', expectedGuests: 450, servingsPerGuest: 1.2, status: 'CONFIRMED' }, [300, 220, 400]);
  const today = await plan(orgs['islamabad-club'], { name: 'Wedding Reception (Walima)', date: new Date(now - 5 * HOUR), venue: 'Islamabad Club Lawn', expectedGuests: 600, servingsPerGuest: 1.1, status: 'COMPLETED' }, [400, 300, 500]);
  const upcoming = await plan(orgs['marriott-islamabad'], { name: 'Tech Conference Lunch', date: new Date(now + 5 * 24 * HOUR), venue: 'Islamabad Marriott Hotel, Margalla Hall', expectedGuests: 300, servingsPerGuest: 1.0, status: 'PLANNED' }, [200, 150, 250]);
  const marquee = await plan(orgs['park-road-banquet'], { name: 'Wedding Baraat Dinner', date: new Date(now + 2 * 24 * HOUR), venue: 'Park Road Banquet Hall, Hall A', expectedGuests: 800, servingsPerGuest: 1.1, status: 'PLANNED' }, [500, 400, 600]);
  const e11 = await plan(orgs['monal-marquee'], { name: 'Mehndi Night', date: new Date(now + 3 * 24 * HOUR), venue: 'Monal Marquee, E-11', expectedGuests: 500, servingsPerGuest: 1.0, status: 'PLANNED' }, [350, 250, 400]);
  // More events across E-11, the Expressway, Bahria Town, DHA and Shakarparian.
  // [organisation slug, event name, offset from now, venue, guests, servings per guest, status]
  const DAY = 24 * HOUR;
  const more = [
    ['zarrar-banquet', 'Wedding Walima', -6 * HOUR, 'Zarrar Banquet Hall, DHA Phase 2', 500, 1.1, 'COMPLETED'],
    ['capital-banquet', 'Corporate Dinner', -4 * HOUR, 'Capital Banquet & Marquee, DHA Phase 2', 300, 1.0, 'COMPLETED'],
    ['bahria-grand-hall', 'School Annual Dinner', -1 * DAY, 'Bahria Grand Hall, Bahria Town Phase 7', 350, 1.0, 'COMPLETED'],
    ['aura-grande', 'Engagement Ceremony (Mangni)', -2 * DAY, 'Aura Grande Complex, E-11', 400, 1.0, 'COMPLETED'],
    ['rubaish-marquee', 'Wedding Mehndi', 1 * DAY, 'Rubaish Marquee, Bahria Town Phase 7', 450, 1.0, 'PLANNED'],
    ['fortress-marquee', 'Wedding Baraat', 4 * DAY, 'Fortress Marquee, Islamabad Expressway', 700, 1.1, 'PLANNED'],
    ['empire-marquee', 'Birthday Banquet', 6 * DAY, 'Empire Marquee, Islamabad Expressway', 200, 1.0, 'PLANNED'],
    ['pak-china-centre', 'Food Festival Lunch', 7 * DAY, 'Pak-China Friendship Centre, Shakarparian', 600, 1.0, 'PLANNED'],
    ['taj-marquee', 'Valima Reception', 9 * DAY, 'Taj Marquee, E-11', 550, 1.1, 'PLANNED'],
  ];
  const extra = {};
  for (const [slug, name, offset, venue, guests, perGuest, status] of more) {
    const servings = [0.9, 0.6, 0.7].map((f) => Math.round(guests * f));
    extra[slug] = await plan(orgs[slug], { name, date: new Date(now + offset), venue, expectedGuests: guests, servingsPerGuest: perGuest, status }, servings);
  }
  return { past, today, upcoming, marquee, e11, ...extra };
}

/** One completed (or failed / expired) rescue in the past, with its full audit trail. */
async function pastRescue(client, ctx, { daysAgo, donor, ngo, volunteer, category, qty, outcome = 'DELIVERED', partial = 0, selfCollect = false, eventId = null, r }) {
  const t0 = new Date(Date.now() - daysAgo * 24 * HOUR - (2 + r() * 4) * HOUR); // evening-ish, days ago
  const at = (m) => new Date(t0.getTime() + m * MIN);
  const safeUntil = at(category.defaultSafeHours * 60);
  const source = { sourceType: eventId ? 'EVENT' : 'RESTAURANT', organisationId: donor.org.id, eventId };
  const loc = donor.org;

  const request = await client.nGORequest.create({
    data: { ngoId: ngo.id, createdById: ngo.managerId, categoryId: category.id, requestedQuantity: qty, requiredBy: at(300), status: outcome === 'DELIVERED' ? 'FULFILLED' : 'EXPIRED', createdAt: at(-60) },
  });
  const listing = await client.surplusListing.create({
    data: {
      ...source, createdById: donor.userId, categoryId: category.id, description: donor.dish, confirmedQuantity: qty,
      preparedAt: t0, safeUntil, collectionDeadline: new Date(safeUntil.getTime() - 60 * MIN), address: loc.address, area: loc.area,
      latitude: loc.latitude, longitude: loc.longitude, safetyConfirmed: true, status: outcome === 'EXPIRED' ? 'EXPIRED' : 'CLOSED', createdAt: at(5),
    },
  });

  const score = Math.round((62 + r() * 33) * 10) / 10;
  const parts = [0.3, 0.25, 0.2, 0.15, 0.1].map((w) => Math.round(score * w * (0.9 + r() * 0.2) * 10) / 10);
  const scoreBreakdown = { freshness: parts[0], feasibility: parts[1], quantityFit: parts[2], proximity: parts[3], fairness: parts[4] };
  const delivered = qty - partial;
  const status = outcome === 'DELIVERED' ? 'DELIVERED' : outcome === 'FAILED' ? 'FAILED' : 'EXPIRED';
  const allocation = await client.allocation.create({
    data: {
      listingId: listing.id, requestId: request.id, quantity: qty, status, score, scoreBreakdown,
      lostQuantity: outcome === 'DELIVERED' ? partial : outcome === 'FAILED' ? qty : 0,
      explanation: `Best match for ${ngo.name}: fresh food ${Math.round(category.defaultSafeHours)}h safe window, within service radius.`,
      proposedAt: at(15), responseDeadline: at(45), pickupDeadline: outcome === 'EXPIRED' ? null : at(135),
      decisionReason: outcome === 'FAILED' ? 'Not delivered before safe-until time' : outcome === 'EXPIRED' ? 'NGO did not respond before the response deadline' : null,
    },
  });

  const h = [
    ['LISTING', listing.id, null, 'OPEN', 'Listing created', 5, donor.userId],
    ['REQUEST', request.id, null, 'OPEN', 'Request created', -60, ngo.managerId],
    ['ALLOCATION', allocation.id, null, 'PROPOSED', allocation.explanation, 15, null],
  ];

  if (outcome === 'EXPIRED') {
    h.push(['ALLOCATION', allocation.id, 'PROPOSED', 'EXPIRED', 'NGO did not respond before the response deadline', 46, null]);
    h.push(['LISTING', listing.id, 'OPEN', 'EXPIRED', 'Collection deadline passed', category.defaultSafeHours * 60 - 59, null]);
    h.push(['REQUEST', request.id, 'OPEN', 'EXPIRED', 'Required-by time passed', 301, null]);
  } else {
    const nonce = newNonce();
    const task = await client.rescueTask.create({
      data: {
        allocationId: allocation.id, collectorType: selfCollect ? 'NGO' : 'VOLUNTEER', volunteerId: selfCollect ? null : volunteer.id,
        otpNonce: nonce, pickupOtpHash: hashOtp(deriveOtp(nonce, 'PICKUP')), deliveryOtpHash: hashOtp(deriveOtp(nonce, 'DELIVERY')),
        otpExpiresAt: safeUntil, claimDeadline: at(80), status: outcome === 'DELIVERED' ? 'DELIVERED' : 'CANCELLED', createdAt: at(30),
      },
    });
    const collectorUserId = selfCollect ? ngo.managerId : volunteer.userId;
    await client.handoverRecord.create({ data: { taskId: task.id, type: 'PICKUP', quantity: outcome === 'DELIVERED' ? qty : qty, recordedById: collectorUserId, recordedAt: at(70) } });
    h.push(
      ['ALLOCATION', allocation.id, 'PROPOSED', 'ACCEPTED', selfCollect ? 'Accepted (NGO will self-collect)' : 'Accepted', 30, ngo.managerId],
      ['TASK', task.id, null, selfCollect ? 'CLAIMED' : 'OPEN', selfCollect ? 'NGO self-collect' : 'Waiting for a volunteer', 30, ngo.managerId],
    );
    if (!selfCollect) h.push(['TASK', task.id, 'OPEN', 'CLAIMED', `Claimed by volunteer ${volunteer.name}`, 40, volunteer.userId]);
    h.push(
      ['TASK', task.id, 'CLAIMED', 'PICKED_UP', 'Pickup verified by code', 70, collectorUserId],
      ['ALLOCATION', allocation.id, 'ACCEPTED', 'PICKED_UP', `Picked up ${qty} servings`, 70, collectorUserId],
    );
    if (outcome === 'DELIVERED') {
      await client.handoverRecord.create({ data: { taskId: task.id, type: 'DELIVERY', quantity: delivered, recordedById: collectorUserId, recordedAt: at(105) } });
      const lostNote = partial ? ` (${partial} servings lost on the way)` : '';
      h.push(
        ['TASK', task.id, 'PICKED_UP', 'DELIVERED', `Delivery verified by code${lostNote}`, 105, collectorUserId],
        ['ALLOCATION', allocation.id, 'PICKED_UP', 'DELIVERED', `Delivered ${delivered} servings${lostNote}`, 105, collectorUserId],
        ['REQUEST', request.id, 'OPEN', 'FULFILLED', 'All requested food delivered', 105, collectorUserId],
        ['LISTING', listing.id, 'OPEN', 'CLOSED', 'All food allocated and handled', 105, collectorUserId],
      );
    } else {
      h.push(
        ['ALLOCATION', allocation.id, 'PICKED_UP', 'FAILED', 'Late delivery: food passed its safe-until time', category.defaultSafeHours * 60 + 1, null],
        ['TASK', task.id, 'PICKED_UP', 'CANCELLED', 'Late delivery', category.defaultSafeHours * 60 + 1, null],
        ['LISTING', listing.id, 'OPEN', 'CLOSED', 'All food allocated and handled', category.defaultSafeHours * 60 + 1, null],
        ['REQUEST', request.id, 'OPEN', 'EXPIRED', 'Required-by time passed', 301, null],
      );
    }
  }

  await client.statusHistory.createMany({
    data: h.map(([entity, entityId, fromStatus, toStatus, reason, minutes, actorUserId]) => ({ entity, entityId, fromStatus, toStatus, reason, actorUserId, time: at(minutes) })),
  });
  ctx.counts[outcome]++;
}

async function seedPastRescues(client, { orgs, volunteers, events }, categoryByName) {
  const r = rng('past-rescues');
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const ngos = Object.values(orgs).filter((o) => o.type === 'NGO' && o.verificationStatus === 'VERIFIED');
  const restaurants = Object.values(orgs).filter((o) => o.type === 'RESTAURANT' && o.verificationStatus === 'VERIFIED');
  const vols = volunteers.filter((v) => v.approvalStatus === 'VERIFIED');
  const ctx = { counts: { DELIVERED: 0, FAILED: 0, EXPIRED: 0 } };

  for (let i = 0; i < 34; i++) {
    const daysAgo = 1 + Math.floor((i / 34) * 14);
    const org = pick(restaurants);
    const [dish, catName] = pick(MENUS[org.menu]);
    const category = categoryByName[catName];
    const donor = { org, userId: org.managerId, dish: `${dish} (end-of-day surplus)` };
    const qty = 15 + Math.floor(r() * 50);
    const outcome = i % 11 === 7 ? 'FAILED' : i % 13 === 9 ? 'EXPIRED' : 'DELIVERED';
    await pastRescue(client, ctx, {
      daysAgo, donor, category, qty, outcome, r,
      ngo: pick(ngos), volunteer: pick(vols), selfCollect: i % 5 === 2,
      partial: outcome === 'DELIVERED' && i % 7 === 3 ? Math.min(3, qty - 1) : 0,
    });
  }

  // The past event's leftovers (Serena Corporate Dinner) were rescued by Edhi Foundation
  const serena = orgs['serena-hotel'];
  await pastRescue(client, ctx, {
    daysAgo: 3, r, eventId: events.past.id, outcome: 'DELIVERED',
    donor: { org: serena, userId: serena.managerId, dish: 'Corporate dinner leftovers: chicken qorma, pulao and naan' },
    ngo: orgs['edhi-foundation'], volunteer: vols[0], category: categoryByName['Cooked meals'], qty: 120,
  });
  return ctx.counts;
}

/** Live data: open listings (one near expiry) and open NGO requests, relative to now. */
async function seedCurrent(client, { orgs, events }, categoryByName) {
  const now = Date.now();
  const listingSpecs = [
    ['savour-foods', 'Chicken pulao and shami kabab (lunch surplus)', 'Rice and biryani', 60, 1.0],
    ['kabul-restaurant', 'Kabuli pulao and chapli kabab', 'Rice and biryani', 45, 1.5],
    ['usmania', 'Chicken karahi and roghni naan', 'Cooked meals', 35, 0.5],
    ['tehzeeb-bakers', 'Chicken patties and sandwich bread', 'Bread and bakery', 80, 3],
    ['kitchen-cuisine', 'Assorted pastries and buns', 'Sweets and desserts', 50, 2],
    ['bravo-foods', 'Burgers and fries (unsold, packed)', 'Fast food', 30, 1],
    ['mandarin-kitchen', 'Chicken fried rice and manchurian', 'Rice and biryani', 40, 2],
    ['chaaye-khana', 'Club sandwiches and pasta', 'Cooked meals', 25, 4.5], // near expiry: < 2 h left
    ['rahat-bakers', 'Bread loaves and rusks', 'Bread and bakery', 70, 5],
    ['des-pardes', 'Daal chawal and chicken qorma', 'Cooked meals', 30, 1],
    ['kfc-f7', 'Zinger burgers (unsold, boxed)', 'Fast food', 20, 2],
    ['tuscany-courtyard', 'Lasagna and penne pasta', 'Pizza and pasta', 25, 1.5],
    ['street-1-cafe', 'Grilled chicken platters', 'Barbecue and kababs', 30, 1],
    ['bundu-khan', 'Chicken tikka and naan', 'Cooked meals', 35, 2],
    ['14th-street-pizza', 'Pizza slices (unsold, boxed)', 'Fast food', 40, 1.5],
    ['hot-and-chilli', 'Spicy wings and fries (unsold, packed)', 'Fast food', 30, 1],
  ];
  let listings = 0;
  const listingBySlug = {};
  for (const [slug, description, catName, qty, hoursAgo] of listingSpecs) {
    const org = orgs[slug];
    const cat = categoryByName[catName];
    const preparedAt = new Date(now - hoursAgo * HOUR);
    const safeUntil = new Date(preparedAt.getTime() + cat.defaultSafeHours * HOUR);
    const collectionDeadline = new Date(safeUntil.getTime() - 30 * MIN);
    const l = await client.surplusListing.create({
      data: { sourceType: 'RESTAURANT', organisationId: org.id, createdById: org.managerId, categoryId: cat.id, description, confirmedQuantity: qty, preparedAt, safeUntil, collectionDeadline, address: org.address, area: org.area, latitude: org.latitude, longitude: org.longitude, handlingNotes: 'Packed in foil trays', dietaryInfo: 'Halal', safetyConfirmed: true },
    });
    await client.statusHistory.create({ data: { entity: 'LISTING', entityId: l.id, toStatus: 'OPEN', reason: 'Listing created', actorUserId: org.managerId } });
    listingBySlug[slug] = l;
    listings++;
  }

  // Leftovers from two DHA events that finished today (event listings)
  const eventListingSpecs = [
    ['zarrar-banquet', 'Walima leftovers: chicken qorma and naan', 'Cooked meals', 40, 3],
    ['capital-banquet', 'Corporate dinner leftovers: mutton qorma and rice', 'Cooked meals', 35, 2],
  ];
  for (const [slug, description, catName, qty, hoursAgo] of eventListingSpecs) {
    const org = orgs[slug];
    const cat = categoryByName[catName];
    const preparedAt = new Date(now - hoursAgo * HOUR);
    const safeUntil = new Date(preparedAt.getTime() + cat.defaultSafeHours * HOUR);
    const l = await client.surplusListing.create({
      data: { sourceType: 'EVENT', organisationId: org.id, eventId: events[slug].id, createdById: org.managerId, categoryId: cat.id, description, confirmedQuantity: qty, preparedAt, safeUntil, collectionDeadline: new Date(safeUntil.getTime() - 30 * MIN), address: org.address, area: org.area, latitude: org.latitude, longitude: org.longitude, handlingNotes: 'Packed in degs and foil trays', dietaryInfo: 'Halal', safetyConfirmed: true },
    });
    await client.statusHistory.create({ data: { entity: 'LISTING', entityId: l.id, toStatus: 'OPEN', reason: 'Event leftovers listed', actorUserId: org.managerId } });
    listingBySlug['event:' + slug] = l;
    listings++;
  }

  const requestSpecs = [
    ['rizq', 'Rice and biryani', 80, 6, 'Evening distribution at F-8 community point'],
    ['robin-hood-army', 'Cooked meals', 60, 5, 'Weekly drive, F-6 and G-6 katchi abadis'],
    ['edhi-foundation', 'Cooked meals', 120, 8, 'Edhi home dinner'],
    ['saylani', 'Rice and biryani', 150, 7, 'Dastarkhwan, I-8'],
    ['sos-village', 'Bread and bakery', 60, 12, "Children's breakfast tomorrow"],
    ['bait-ul-mal', 'Sweets and desserts', 40, 10, 'Sweet Home evening tea'],
    ['akhuwat', 'Fast food', 30, 4, 'Volunteer iftar-style evening meal'],
    ['bahria-community-kitchen', 'Cooked meals', 70, 6, 'Evening meal, Bahria Town Phase 7'],
    ['dha-welfare-dastarkhwan', 'Cooked meals', 50, 6, 'Dastarkhwan, DHA Phase 2'],
    ['margalla-old-age-home', 'Bread and bakery', 40, 12, 'Breakfast for residents'],
    ['thali', 'Lentils and vegetable dishes', 60, 6, 'Daal and sabzi for the evening meal'],
    ['chhipa', 'Barbecue and kababs', 50, 6, 'Evening meal, I-9 shelter'],
  ];
  let requests = 0;
  const requestBySlug = {};
  for (const [slug, catName, qty, hours, notes] of requestSpecs) {
    const ngo = orgs[slug];
    const r = await client.nGORequest.create({ data: { ngoId: ngo.id, createdById: ngo.managerId, categoryId: categoryByName[catName].id, requestedQuantity: qty, requiredBy: new Date(now + hours * HOUR), notes } });
    await client.statusHistory.create({ data: { entity: 'REQUEST', entityId: r.id, toStatus: 'OPEN', reason: 'Request created', actorUserId: ngo.managerId } });
    requestBySlug[slug] = r;
    requests++;
  }

  // READY-TO-CLAIM POOLED TRIPS: each NGO request is filled by 2 or 3 donors, every offer
  // already accepted, so a volunteer sees one trip per request (GET /api/tasks/trips).
  // Categories match, and every listing keeps some food left. [request slug, [[listing, servings], ...]]
  const pools = [
    ['rizq', [['savour-foods', 50], ['kabul-restaurant', 30]]],
    ['edhi-foundation', [['usmania', 30], ['bundu-khan', 30], ['des-pardes', 25]]],
    ['sos-village', [['tehzeeb-bakers', 40], ['rahat-bakers', 20]]],
    ['akhuwat', [['kfc-f7', 12], ['bravo-foods', 18]]],
    ['dha-welfare-dastarkhwan', [['event:zarrar-banquet', 30], ['event:capital-banquet', 20]]],
  ];
  let pooledTripTasks = 0;
  for (const [ngoSlug, parts] of pools) {
    const request = requestBySlug[ngoSlug];
    const ngo = orgs[ngoSlug];
    for (const [listingKey, qty] of parts) {
      const listing = listingBySlug[listingKey];
      if (!listing || !request) throw new Error('Seed pool data is wrong: ' + ngoSlug + ' / ' + listingKey);
      const proposedAt = new Date(now - 20 * MIN);
      const others = parts.length - 1;
      const allocation = await client.allocation.create({
        data: {
          listingId: listing.id, requestId: request.id, quantity: qty, status: 'ACCEPTED', proposedAt,
          responseDeadline: new Date(proposedAt.getTime() + 30 * MIN), pickupDeadline: new Date(Math.min(now + 100 * MIN, listing.collectionDeadline.getTime())),
          score: 75 + parts.length * 3, explanation: 'Pooled with ' + others + ' other nearby donor' + (others > 1 ? 's' : '') + ' to fill one larger request',
        },
      });
      const nonce = newNonce();
      const task = await client.rescueTask.create({
        data: {
          allocationId: allocation.id, collectorType: 'VOLUNTEER', status: 'OPEN', otpNonce: nonce,
          pickupOtpHash: hashOtp(deriveOtp(nonce, 'PICKUP')), deliveryOtpHash: hashOtp(deriveOtp(nonce, 'DELIVERY')), otpExpiresAt: listing.safeUntil,
        },
      });
      await client.statusHistory.createMany({
        data: [
          { entity: 'ALLOCATION', entityId: allocation.id, toStatus: 'PROPOSED', reason: allocation.explanation, time: proposedAt },
          { entity: 'ALLOCATION', entityId: allocation.id, fromStatus: 'PROPOSED', toStatus: 'ACCEPTED', reason: 'Accepted', actorUserId: ngo.managerId, time: new Date(now - 10 * MIN) },
          { entity: 'TASK', entityId: task.id, toStatus: 'OPEN', reason: 'Waiting for a volunteer', actorUserId: ngo.managerId, time: new Date(now - 10 * MIN) },
        ],
      });
      pooledTripTasks++;
    }
  }
  return { listings, requests, pooledTrips: pools.length, pooledTripTasks };
}

// ---------------------------------------------------------------- entry point

export async function seed(client = prisma, { activity = false, log = () => {} } = {}) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  log('Seeding categories, config, organisations and accounts...');
  const base = await seedBase(client, passwordHash);
  const summary = {
    categories: CATEGORIES.length,
    restaurants: RESTAURANTS.length,
    marqueesCaterers: MARQUEES_CATERERS.length,
    ngos: NGOS.length,
    volunteers: VOLUNTEERS.length,
  };
  if (!activity) return summary;

  if ((await client.surplusListing.count()) > 0) {
    log('Listings already exist, so demo activity was skipped (use npm run demo:reset -- --yes for a fresh demo).');
    return summary;
  }
  const categoryByName = Object.fromEntries((await client.foodCategory.findMany()).map((c) => [c.name, c]));
  log('Seeding 4 weeks of restaurant food records...');
  summary.dailyFoodRecords = await seedFoodRecords(client, base.orgs, categoryByName);
  log('Seeding events...');
  const events = await seedEvents(client, base.orgs);
  summary.events = Object.keys(events).length;
  log('Seeding two weeks of past rescues (this takes a minute on a remote database)...');
  summary.pastRescues = await seedPastRescues(client, { ...base, events }, categoryByName);
  log('Seeding current open listings and requests...');
  Object.assign(summary, await seedCurrent(client, { ...base, events }, categoryByName));
  return summary;
}

// Run directly: `npm run seed`
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('prisma/seed.js')) {
  seed(prisma, { activity: !process.argv.includes('--base-only'), log: (m) => console.log(m) })
    .then((r) => console.log('Seed complete:', r, `\nEvery account's password: ${PASSWORD}`))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

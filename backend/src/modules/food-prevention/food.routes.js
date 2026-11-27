// Track A, Prevention routes (M2, Member 2), mounted at /api/food.
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, requireVerified } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './food.service.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-27');
const id = z.coerce.number().int().positive();
const servings = z.number().int().min(0).max(100000);

const itemSchema = z.object({ name: z.string().trim().min(2).max(80), categoryId: z.number().int().positive() });
const planSchema = z.object({ foodItemId: z.number().int().positive(), date: dateStr, planned: servings });
const actualsSchema = z
  .object({
    foodItemId: z.number().int().positive(),
    date: dateStr,
    prepared: servings.optional(),
    sold: servings.optional(),
    wasted: servings.optional(),
    wasteReason: z.string().trim().max(200).optional(),
    soldOut: z.boolean().optional(),
  })
  .strict();
const orgQuery = { organisationId: id.optional() };

const router = Router();
router.use(authenticate, requireRole('DONOR', 'ADMIN'), requireVerified);

// Menu items (restaurants and marquees / caterers; marquees use them in event food plans)
router.get('/items', validate({ query: z.object(orgQuery) }), async (req, res) => {
  res.json({ items: await service.listItems(req.user, req.q) });
});
router.post('/items', requireRole('DONOR'), validate({ body: itemSchema }), async (req, res) => {
  res.status(201).json({ item: await service.createItem(req.user, req.body) });
});

// Forecast for each menu item on a day (default today), with that day's record and warning
router.get('/forecast', validate({ query: z.object({ date: dateStr.optional(), ...orgQuery }) }), async (req, res) => {
  res.json(await service.getForecast(req.user, req.q));
});

// Daily records: plan first (locks plan + forecast shown), then actual figures
router.post('/records/plan', requireRole('DONOR'), validate({ body: planSchema }), async (req, res) => {
  res.status(201).json(await service.savePlan(req.user, req.body));
});
router.patch('/records/actuals', requireRole('DONOR'), validate({ body: actualsSchema }), async (req, res) => {
  res.json({ record: await service.saveActuals(req.user, req.body) });
});
router.get(
  '/records',
  validate({ query: z.object({ from: dateStr.optional(), to: dateStr.optional(), foodItemId: id.optional(), ...orgQuery }) }),
  async (req, res) => {
    res.json({ records: await service.listRecords(req.user, req.q) });
  },
);

// Totals: prepared, sold, wasted, waste ratio, prevented (per item and per week)
router.get('/summary', validate({ query: z.object({ days: z.coerce.number().int().min(1).max(90).default(28), ...orgQuery }) }), async (req, res) => {
  res.json(await service.summary(req.user, req.q));
});

export default router;

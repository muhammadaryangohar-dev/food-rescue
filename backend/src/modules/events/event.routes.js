// Events routes (M3, Member 2), mounted at /api/events. Marquees / caterers (and admins).
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, requireVerified } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './event.service.js';

const datetime = z.coerce.date({ invalid_type_error: 'Enter a valid date and time' });
const idParams = z.object({ id: z.coerce.number().int().positive() });
const plans = z.array(z.object({ foodItemId: z.number().int().positive(), plannedServings: z.number().int().min(1).max(100000) })).max(50);

const eventFields = {
  name: z.string().trim().min(3).max(120),
  date: datetime,
  venue: z.string().trim().min(3).max(200),
  expectedGuests: z.number().int().min(1).max(100000),
  servingsPerGuest: z.number().min(0.1).max(10).default(1),
};
const createSchema = z.object({ ...eventFields, plans: plans.default([]) }).strict();
const updateSchema = z
  .object({ ...eventFields, servingsPerGuest: eventFields.servingsPerGuest.optional(), plans })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Nothing to update');
// What was actually cooked per dish (for the prevented-food counter)
const prepared = z.array(z.object({ foodItemId: z.number().int().positive(), preparedServings: z.number().int().min(0).max(100000) })).max(50);
const completeSchema = z.object({ prepared: prepared.default([]) });
const leftoversSchema = z.object({
  safetyConfirmed: z.boolean().optional(),
  prepared: prepared.default([]),
  leftovers: z
    .array(
      z.object({
        categoryId: z.number().int().positive(),
        description: z.string().trim().min(3).max(500),
        quantity: z.number().int().min(1).max(100000),
        preparedAt: datetime.optional(),
        safeUntil: datetime.optional(),
        collectionDeadline: datetime.optional(),
        handlingNotes: z.string().trim().max(500).optional(),
        dietaryInfo: z.string().trim().max(200).optional(),
      }),
    )
    .max(30),
});

const router = Router();
router.use(authenticate, requireRole('DONOR', 'ADMIN'));

router.get('/', validate({ query: z.object({ status: z.enum(['PLANNED', 'COMPLETED', 'CONFIRMED']).optional() }) }), async (req, res) => {
  res.json({ events: await service.listEvents(req.user, req.q) });
});
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ event: await service.getEvent(req.user, req.params.id) });
});
router.post('/', requireRole('DONOR'), requireVerified, validate({ body: createSchema }), async (req, res) => {
  res.status(201).json({ event: await service.createEvent(req.user, req.body) });
});
router.patch('/:id', requireRole('DONOR'), requireVerified, validate({ params: idParams, body: updateSchema }), async (req, res) => {
  res.json({ event: await service.updateEvent(req.user, req.params.id, req.body) });
});
// Mark the event as held; optionally send what was cooked per dish: { prepared: [{ foodItemId, preparedServings }] }
router.post('/:id/complete', requireRole('DONOR'), requireVerified, validate({ params: idParams, body: completeSchema }), async (req, res) => {
  res.json({ event: await service.completeEvent(req.user, req.params.id, req.body) });
});
// Confirm actual leftovers: each becomes a surplus listing; [] means "no leftovers"
router.post('/:id/leftovers', requireRole('DONOR'), requireVerified, validate({ params: idParams, body: leftoversSchema }), async (req, res) => {
  res.status(201).json(await service.confirmLeftovers(req.user, req.params.id, req.body));
});

export default router;

import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { otpLimiter } from '../../middleware/rateLimit.js';
import * as service from './rescue.service.js';
import * as trips from './trip.service.js';

const router = Router();
router.use(authenticate);

const idParams = z.object({ id: z.coerce.number().int().positive() });
const handoverSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'The code has 6 digits'),
  quantity: z.number().int().min(1, 'Quantity must be at least 1'),
});

router.get('/available', requireRole('VOLUNTEER'), async (req, res) => {
  res.json({ tasks: await service.listAvailableTasks(req.user) });
});

router.get('/mine', validate({ query: z.object({ status: z.string().regex(/^[A-Z_,]+$/).optional() }) }), async (req, res) => {
  res.json({ tasks: await service.listMyTasks(req.user, req.q) });
});

// ---- pooled trips (one volunteer collects several donors' food for one NGO request)
router.get('/trips', requireRole('VOLUNTEER'), async (req, res) => {
  res.json({ trips: await trips.listAvailableTrips(req.user) });
});

router.get('/trips/mine', requireRole('VOLUNTEER'), async (req, res) => {
  res.json({ trips: await trips.listMyTrips(req.user) });
});

router.post(
  '/trips/:requestId/claim',
  requireRole('VOLUNTEER'),
  validate({
    params: z.object({ requestId: z.coerce.number().int().positive() }),
    body: z.object({ taskIds: z.array(z.number().int().positive()).min(1).max(10).refine((a) => new Set(a).size === a.length, 'Task ids must be different') }),
  }),
  async (req, res) => {
    res.json({ trip: await trips.claimTrip(req.user, req.params.requestId, req.body.taskIds) });
  },
);

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ task: await service.getTask(req.user, req.params.id) });
});

router.post('/:id/claim', requireRole('VOLUNTEER'), validate({ params: idParams }), async (req, res) => {
  res.json({ task: await service.claimTask(req.user, req.params.id) });
});

router.post('/:id/unclaim', requireRole('VOLUNTEER'), validate({ params: idParams }), async (req, res) => {
  res.json({ task: await service.unclaimTask(req.user, req.params.id) });
});

router.post('/:id/pickup', otpLimiter, requireRole('VOLUNTEER', 'NGO'), validate({ params: idParams, body: handoverSchema }), async (req, res) => {
  res.json(await service.confirmPickup(req.user, req.params.id, req.body));
});

router.post('/:id/deliver', otpLimiter, requireRole('VOLUNTEER', 'NGO'), validate({ params: idParams, body: handoverSchema }), async (req, res) => {
  res.json(await service.confirmDelivery(req.user, req.params.id, req.body));
});

router.post(
  '/:id/reject-quality',
  requireRole('NGO', 'ADMIN'),
  validate({ params: idParams, body: z.object({ reason: z.string().trim().min(3, 'Describe the problem').max(300) }) }),
  async (req, res) => {
    res.json({ task: await service.rejectForQuality(req.user, req.params.id, req.body) });
  },
);

export default router;

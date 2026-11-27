import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './allocation.service.js';
import * as query from './allocation.query.js';

const router = Router();
router.use(authenticate);

const idParams = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({
  status: z.string().regex(/^[A-Z_,]+$/).optional(), // e.g. PROPOSED or PROPOSED,ACCEPTED
  requestId: z.coerce.number().int().positive().optional(),
  listingId: z.coerce.number().int().positive().optional(),
});

router.get('/', validate({ query: listQuery }), async (req, res) => {
  res.json({ allocations: await query.listAllocations(req.user, req.q) });
});

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ allocation: await query.getAllocation(req.user, req.params.id) });
});

router.get('/:id/timeline', validate({ params: idParams }), async (req, res) => {
  res.json({ timeline: await query.getTimeline(req.user, req.params.id) });
});

router.post(
  '/:id/accept',
  requireRole('NGO'),
  validate({ params: idParams, body: z.object({ selfCollect: z.boolean().default(false) }) }),
  async (req, res) => {
    res.json({ allocation: await service.acceptAllocation(req.user, req.params.id, req.body) });
  },
);

router.post(
  '/:id/reject',
  requireRole('NGO'),
  validate({ params: idParams, body: z.object({ reason: z.string().trim().min(3, 'Give a short reason').max(300) }) }),
  async (req, res) => {
    res.json({ allocation: await service.rejectAllocation(req.user, req.params.id, req.body) });
  },
);

router.post(
  '/:id/cancel',
  requireRole('NGO', 'ADMIN'),
  validate({ params: idParams, body: z.object({ reason: z.string().trim().max(300).optional() }) }),
  async (req, res) => {
    res.json({ allocation: await service.cancelAllocation(req.user, req.params.id, req.body) });
  },
);

export default router;

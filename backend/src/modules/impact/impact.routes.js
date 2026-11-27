// Impact routes (M9, Member 2), mounted at /api/impact.
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { impactSummary } from './impact.service.js';

const router = Router();
router.use(authenticate);

// Prevented / Rescued / Lost totals, rescue rate, trend, top donors, by NGO type.
// scope=mine gives a donor or NGO its own numbers; admins always see everything.
const query = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  scope: z.enum(['all', 'mine']).default('all'),
  interval: z.enum(['day', 'week']).default('day'),
});
router.get('/summary', validate({ query }), async (req, res) => {
  res.json(await impactSummary(req.user, req.q));
});

export default router;

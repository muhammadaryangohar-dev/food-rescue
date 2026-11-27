// Fairness routes (M10, Member 2), mounted at /api/fairness. Admins and NGOs.
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { fairnessLedger } from './fairness.service.js';

const router = Router();
router.use(authenticate, requireRole('ADMIN', 'NGO'));

// Fairness ledger: servings per NGO in the window, share, fairness points, Gini coefficient
router.get('/', validate({ query: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }) }), async (req, res) => {
  res.json(await fairnessLedger(req.q));
});

export default router;

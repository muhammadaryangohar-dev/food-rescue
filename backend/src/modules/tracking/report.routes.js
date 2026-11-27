import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './report.service.js';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  allocationId: z.number().int().positive(),
  type: z.enum(['NO_SHOW', 'QUALITY', 'QUANTITY_MISMATCH', 'NOT_DELIVERED', 'SAFETY', 'OTHER']),
  description: z.string().trim().min(5, 'Describe what happened').max(1000),
});

router.post('/', validate({ body: createSchema }), async (req, res) => {
  res.status(201).json({ report: await service.createReport(req.user, req.body) });
});

// Admins see all reports; everyone else sees the reports they filed
router.get('/', validate({ query: z.object({ status: z.enum(['OPEN', 'UPHELD', 'DISMISSED']).optional() }) }), async (req, res) => {
  res.json({ reports: await service.listReports(req.user, req.q) });
});

export default router;

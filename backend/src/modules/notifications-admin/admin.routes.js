import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as admin from './admin.service.js';
import { unlockTask } from '../rescue/rescue.service.js';
import { resolveReport } from '../tracking/report.service.js';
import { runConcurrencyDemo } from './concurrency-demo.service.js';
import { compareWeights } from '../matching/matching.compare.js';
import { reliabilityReport } from '../tracking/reliability.service.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

const router = Router();
router.use(authenticate, requireRole('ADMIN'));

const idParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * Demo-only tools (live concurrency demo, simulate expiry) change real data on purpose,
 * so they are switched off in production unless ENABLE_DEMO_TOOLS=true (see config/env.js).
 * Read at request time so the switch can be tested.
 */
function demoToolsOnly(_req, _res, next) {
  if (!env.demoTools) throw new AppError(404, 'DEMO_TOOLS_DISABLED', 'Demo tools are turned off on this server');
  next();
}
const verifyBody = z.object({ status: z.enum(['VERIFIED', 'REJECTED', 'PENDING']) });

// ---- verification (FR2)
router.get('/verifications', validate({ query: z.object({ status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).default('PENDING') }) }), async (req, res) => {
  res.json(await admin.pendingVerifications(req.q.status));
});
router.patch('/organisations/:id/verification', validate({ params: idParams, body: verifyBody }), async (req, res) => {
  res.json({ organisation: await admin.setOrganisationVerification(req.params.id, req.body.status) });
});
router.patch('/volunteers/:id/verification', validate({ params: idParams, body: verifyBody.extend({ resetNoShows: z.boolean().optional() }) }), async (req, res) => {
  res.json({ volunteer: await admin.setVolunteerApproval(req.params.id, req.body.status, req.body.resetNoShows) });
});

// ---- users
router.get('/users', validate({ query: z.object({ role: z.enum(['DONOR', 'NGO', 'VOLUNTEER', 'ADMIN']).optional(), active: z.enum(['true', 'false']).optional() }) }), async (req, res) => {
  res.json({ users: await admin.listUsers(req.q) });
});
router.patch('/users/:id/active', validate({ params: idParams, body: z.object({ active: z.boolean() }) }), async (req, res) => {
  res.json({ user: await admin.setUserActive(req.user, req.params.id, req.body.active) });
});

// ---- reliability scores (lowest first, NEW at the end)
router.get('/reliability', validate({ query: z.object({ role: z.enum(['NGO', 'VOLUNTEER']) }) }), async (req, res) => {
  res.json({ role: req.q.role, scores: await reliabilityReport(req.q.role) });
});

// ---- configuration panel
router.get('/config', async (_req, res) => {
  res.json({ config: await admin.getConfigView() });
});
router.put(
  '/config/:key',
  validate({ params: z.object({ key: z.string().regex(/^[A-Z_]+$/) }), body: z.object({ value: z.union([z.string(), z.number()]) }) }),
  async (req, res) => {
    res.json({ config: await admin.setConfig(req.user, req.params.key, req.body.value) });
  },
);

// ---- engine controls
router.post('/sweep', async (_req, res) => {
  res.json({ sweep: await admin.runSweepNow() });
});
router.post('/matching/run', async (_req, res) => {
  res.json(await admin.runMatching());
});

// Weight comparison: the real engine runs once per weight set in a rolled-back transaction
const pct = z.number().min(0).max(100);
const weightsSchema = z
  .object({ freshness: pct, feasibility: pct, quantityFit: pct, proximity: pct, fairness: pct })
  .refine((w) => Math.abs(Object.values(w).reduce((s, x) => s + x, 0) - 100) < 0.001, 'Weights must add up to 100');
router.post(
  '/matching/compare',
  validate({ body: z.object({ weightSets: z.array(z.object({ name: z.string().trim().min(1).max(60), weights: weightsSchema })).min(1).max(4) }) }),
  async (req, res) => {
    res.json(await compareWeights(req.body.weightSets));
  },
);

// Live concurrency demonstration (objective 4)
router.post(
  '/demo/concurrency',
  demoToolsOnly,
  validate({ body: z.object({ attempts: z.number().int().min(2).max(30).default(10), compare: z.boolean().default(false) }) }),
  async (req, res) => {
    res.json(await runConcurrencyDemo(req.body));
  },
);
router.post(
  '/allocations',
  validate({ body: z.object({ listingId: z.number().int().positive(), requestId: z.number().int().positive(), quantity: z.number().int().positive(), explanation: z.string().max(300).optional() }) }),
  async (req, res) => {
    res.status(201).json({ allocation: await admin.manualAllocation(req.user, req.body) });
  },
);
router.post('/tasks/:id/unlock', validate({ params: idParams }), async (req, res) => {
  res.json({ task: await unlockTask(req.user, req.params.id) });
});
router.post(
  '/simulate/expire',
  demoToolsOnly,
  validate({
    body: z
      .object({ listingId: z.number().int().positive().optional(), allocationId: z.number().int().positive().optional(), requestId: z.number().int().positive().optional(), taskId: z.number().int().positive().optional() })
      .refine((b) => Object.keys(b).length > 0, 'Give a listingId, allocationId, requestId or taskId'),
  }),
  async (req, res) => {
    res.json(await admin.simulateExpiry(req.user, req.body));
  },
);

// ---- reports
router.patch(
  '/reports/:id/resolve',
  validate({ params: idParams, body: z.object({ status: z.enum(['UPHELD', 'DISMISSED']), resolutionNote: z.string().trim().min(3).max(1000), reverseDelivery: z.boolean().optional() }) }),
  async (req, res) => {
    res.json(await resolveReport(req.user, req.params.id, req.body));
  },
);

export default router;

import { Router } from 'express';
import { authenticate, requireRole, requireVerified } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { createRequestSchema, updateRequestSchema, listQuerySchema, idParams, cancelSchema } from './request.schemas.js';
import * as service from './request.service.js';

const router = Router();
router.use(authenticate);

router.post('/', requireRole('NGO'), requireVerified, validate({ body: createRequestSchema }), async (req, res) => {
  res.status(201).json({ request: await service.createRequest(req.user, req.body) });
});

router.get('/', requireRole('NGO', 'ADMIN'), validate({ query: listQuerySchema }), async (req, res) => {
  res.json({ requests: await service.listRequests(req.user, req.q) });
});

router.get('/:id', requireRole('NGO', 'ADMIN'), validate({ params: idParams }), async (req, res) => {
  res.json({ request: await service.getRequest(req.user, req.params.id) });
});

// "Why wasn't I matched?": decisions of the latest matching run for this request
router.get('/:id/match-decisions', requireRole('NGO', 'ADMIN'), validate({ params: idParams }), async (req, res) => {
  res.json(await service.getMatchDecisions(req.user, req.params.id));
});

router.patch('/:id', requireRole('NGO', 'ADMIN'), validate({ params: idParams, body: updateRequestSchema }), async (req, res) => {
  res.json({ request: await service.updateRequest(req.user, req.params.id, req.body) });
});

router.post('/:id/cancel', requireRole('NGO', 'ADMIN'), validate({ params: idParams, body: cancelSchema }), async (req, res) => {
  res.json(await service.cancelRequest(req.user, req.params.id, req.body));
});

export default router;

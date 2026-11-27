import { Router } from 'express';
import { authenticate, requireRole, requireVerified } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { createListingSchema, updateListingSchema, listQuerySchema, idParams, withdrawSchema } from './listing.schemas.js';
import * as service from './listing.service.js';

const router = Router();
router.use(authenticate);

router.post('/', requireRole('DONOR'), requireVerified, validate({ body: createListingSchema }), async (req, res) => {
  res.status(201).json({ listing: await service.createListing(req.user, req.body) });
});

router.get('/', validate({ query: listQuerySchema }), async (req, res) => {
  res.json({ listings: await service.listListings(req.user, req.q) });
});

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ listing: await service.getListing(req.user, req.params.id) });
});

router.patch('/:id', requireRole('DONOR', 'ADMIN'), validate({ params: idParams, body: updateListingSchema }), async (req, res) => {
  res.json({ listing: await service.updateListing(req.user, req.params.id, req.body) });
});

router.post('/:id/withdraw', requireRole('DONOR', 'ADMIN'), validate({ params: idParams, body: withdrawSchema }), async (req, res) => {
  res.json(await service.withdrawListing(req.user, req.params.id, req.body));
});

export default router;

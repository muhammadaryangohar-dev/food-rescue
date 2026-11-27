// Public NGO directory for households. No login needed (rate limited like the rest of /api).
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { listNgos, getNgo } from './ngo-directory.service.js';
import { NGO_TYPES } from '../access/access.schemas.js';

const router = Router();

const listQuery = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    area: z.string().trim().min(1).max(100).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    ngoType: z.enum(NGO_TYPES).optional(),
  })
  .refine((d) => (d.lat === undefined) === (d.lng === undefined), { message: 'Send both lat and lng, or neither', path: ['lat'] });

router.get('/', validate({ query: listQuery }), async (req, res) => {
  res.json(await listNgos(req.q));
});

router.get('/:id', validate({ params: z.object({ id: z.coerce.number().int().positive() }) }), async (req, res) => {
  res.json({ ngo: await getNgo(req.params.id) });
});

export default router;

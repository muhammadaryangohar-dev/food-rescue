// M8 Location: area list for the manual-area fallback when the map cannot load.
import { Router } from 'express';
import { ISLAMABAD_AREAS } from '../../lib/areas.js';

const router = Router();

// Public (needed on the registration form before login)
router.get('/', (_req, res) => {
  res.json({ city: 'Islamabad', areas: ISLAMABAD_AREAS });
});

export default router;

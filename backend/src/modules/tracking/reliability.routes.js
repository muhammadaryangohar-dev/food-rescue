import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { myReliability } from './reliability.service.js';

const router = Router();

// An NGO or volunteer sees its own reliability score (admins use /api/admin/reliability)
router.get('/me', authenticate, requireRole('NGO', 'VOLUNTEER'), async (req, res) => {
  res.json({ reliability: await myReliability(req.user) });
});

export default router;

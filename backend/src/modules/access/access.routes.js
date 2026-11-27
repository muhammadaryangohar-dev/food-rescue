import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { loginLimiter } from '../../middleware/rateLimit.js';
import { registerSchema, loginSchema, updateMeSchema, changePasswordSchema } from './access.schemas.js';
import * as service from './access.service.js';

const router = Router();

router.post('/register', loginLimiter, validate({ body: registerSchema }), async (req, res) => {
  res.status(201).json(await service.register(req.body));
});

router.post('/login', loginLimiter, validate({ body: loginSchema }), async (req, res) => {
  res.json(await service.login(req.body));
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: service.me(req.user) });
});

router.patch('/me', authenticate, validate({ body: updateMeSchema }), async (req, res) => {
  res.json({ user: await service.updateMe(req.user, req.body) });
});

router.post('/change-password', authenticate, validate({ body: changePasswordSchema }), async (req, res) => {
  res.json(await service.changePassword(req.user, req.body));
});

export default router;

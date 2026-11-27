// M12 notifications. The front-end polls these (no WebSockets needed).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { notFound } from '../../lib/errors.js';

const router = Router();
router.use(authenticate);

router.get('/', validate({ query: z.object({ unread: z.enum(['true', 'false']).optional() }) }), async (req, res) => {
  const where = { userId: req.user.id };
  if (req.q.unread === 'true') where.isRead = false;
  const notifications = await prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ notifications });
});

router.get('/unread-count', async (req, res) => {
  res.json({ count: await prisma.notification.count({ where: { userId: req.user.id, isRead: false } }) });
});

router.patch('/:id/read', validate({ params: z.object({ id: z.coerce.number().int().positive() }) }), async (req, res) => {
  const { count } = await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.user.id }, data: { isRead: true } });
  if (count === 0) throw notFound('Notification');
  res.json({ ok: true });
});

router.post('/read-all', async (req, res) => {
  const { count } = await prisma.notification.updateMany({ where: { userId: req.user.id, isRead: false }, data: { isRead: true } });
  res.json({ updated: count });
});

export default router;

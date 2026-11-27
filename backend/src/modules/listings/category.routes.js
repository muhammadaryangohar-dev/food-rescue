// Food categories (read by everyone; managed by admins).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';

const router = Router();

router.get('/', async (_req, res) => {
  res.json({ categories: await prisma.foodCategory.findMany({ orderBy: { name: 'asc' } }) });
});

const categorySchema = z.object({
  name: z.string().trim().min(2).max(60),
  defaultSafeHours: z.number().int().min(1).max(168),
});

router.post('/', authenticate, requireRole('ADMIN'), validate({ body: categorySchema }), async (req, res) => {
  res.status(201).json({ category: await prisma.foodCategory.create({ data: req.body }) });
});

router.patch(
  '/:id',
  authenticate,
  requireRole('ADMIN'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }), body: categorySchema.partial() }),
  async (req, res) => {
    res.json({ category: await prisma.foodCategory.update({ where: { id: req.params.id }, data: req.body }) });
  },
);

export default router;

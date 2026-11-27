import { z } from 'zod';

export const idParams = z.object({ id: z.coerce.number().int().positive() });

export const createRequestSchema = z.object({
  categoryId: z.number().int().positive(),
  requestedQuantity: z.number().int().min(1, 'Request at least 1 serving').max(100000),
  requiredBy: z.coerce.date({ invalid_type_error: 'Enter a valid date and time' }),
  notes: z.string().trim().max(500).optional(),
});

export const updateRequestSchema = createRequestSchema.partial().strict().refine((d) => Object.keys(d).length > 0, 'Nothing to update');

export const listQuerySchema = z.object({
  status: z.enum(['OPEN', 'FULFILLED', 'CANCELLED', 'EXPIRED']).optional(),
});

export const cancelSchema = z.object({ reason: z.string().trim().max(300).optional() });

import { z } from 'zod';

const datetime = z.coerce.date({ invalid_type_error: 'Enter a valid date and time' });
const id = z.coerce.number().int().positive();

export const idParams = z.object({ id });

export const createListingSchema = z.object({
  categoryId: z.number().int().positive(),
  description: z.string().trim().min(3, 'Describe the food').max(500),
  confirmedQuantity: z.number().int().min(1, 'Quantity must be at least 1 serving').max(100000),
  preparedAt: datetime,
  safeUntil: datetime,
  collectionDeadline: datetime,
  address: z.string().trim().min(3).max(300).optional(),
  area: z.string().trim().min(2).max(100).optional(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  handlingNotes: z.string().trim().max(500).optional(),
  dietaryInfo: z.string().trim().max(200).optional(),
  safetyConfirmed: z.literal(true, { errorMap: () => ({ message: 'You must confirm the food is safe to eat' }) }),
  eventId: z.number().int().positive().optional(),
});

// Fields that are locked once the listing has any allocation (edit-vs-consistency trade-off)
export const LOCKED_FIELDS = ['categoryId', 'confirmedQuantity', 'preparedAt', 'safeUntil', 'collectionDeadline', 'address', 'area', 'latitude', 'longitude'];

export const updateListingSchema = createListingSchema
  .omit({ safetyConfirmed: true, eventId: true })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Nothing to update');

export const listQuerySchema = z.object({
  status: z.enum(['OPEN', 'CLOSED', 'EXPIRED']).optional(),
  categoryId: id.optional(),
  area: z.string().trim().optional(),
});

export const withdrawSchema = z.object({ reason: z.string().trim().max(300).optional() });

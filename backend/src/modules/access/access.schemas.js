import { z } from 'zod';
import { pkToday } from '../../lib/time.js';

const email = z.string().trim().toLowerCase().email('Enter a valid email address');
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');
const phone = z.string().trim().regex(/^\+?[0-9 -]{7,20}$/, 'Enter a valid phone number');
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

const location = {
  address: z.string().trim().min(3, 'Address is required').max(300),
  area: z.string().trim().min(2, 'Area is required').max(100),
  latitude: lat.optional().nullable(),
  longitude: lng.optional().nullable(),
};

const organisation = z.object({
  name: z.string().trim().min(2, 'Organisation name is required').max(150),
  ...location,
  contactPhone: phone.optional(),
  contactEmail: email.optional(),
});

// Food licence of a donor business (restaurant, marquee, caterer, event venue)
const licence = {
  licenceNumber: z.string().trim().min(3, 'Food licence number is required').max(50),
  licenceAuthority: z.string().trim().min(3).max(100).default('Islamabad Food Authority'),
  licenceExpiresOn: z.coerce.date().optional(),
};

const donorOrganisation = organisation.extend(licence);

export const NGO_TYPES = ['FOOD_KITCHEN', 'ORPHANAGE', 'OLD_AGE_HOME', 'SHELTER', 'OTHER'];

// Servings per person per day that still count as believable (breakfast, lunch, dinner)
export const MAX_SERVINGS_PER_BENEFICIARY = 3;

const ngoOrganisation = organisation.extend({
  ngoType: z.enum(NGO_TYPES, { errorMap: () => ({ message: `NGO type must be one of ${NGO_TYPES.join(', ')}` }) }),
  dailyCapacity: z.number().int().min(1, 'Daily capacity is required').max(100000),
  beneficiaries: z.number().int().min(1, 'Number of people served is required').max(100000),
  serviceRadiusKm: z.number().min(0.5).max(200),
  description: z.string().trim().max(500).optional(),
  // Opt-in: only then do name, type, area and the public contact appear in the NGO directory
  showInDirectory: z.boolean().default(false),
});

/** Rules shared by registration and profile edits for NGOs (checked on the final values). */
export function ngoRuleErrors({ dailyCapacity, beneficiaries, showInDirectory, contactPhone, contactEmail }) {
  const errors = [];
  if (dailyCapacity != null && beneficiaries != null && dailyCapacity > beneficiaries * MAX_SERVINGS_PER_BENEFICIARY) {
    errors.push({ path: ['organisation', 'dailyCapacity'], message: `Daily capacity cannot be more than ${MAX_SERVINGS_PER_BENEFICIARY} servings per person served (${beneficiaries * MAX_SERVINGS_PER_BENEFICIARY})` });
  }
  if (showInDirectory && !contactPhone && !contactEmail) {
    errors.push({ path: ['organisation', 'contactPhone'], message: 'Add a public contact phone or email to appear in the NGO directory' });
  }
  return errors;
}

export const NOT_A_DONOR_MESSAGE =
  'Only licensed restaurants and marquees / caterers can donate on FoodRescue. Households: see the NGO directory (GET /api/ngos) and contact an NGO directly.';

// Today's date in Pakistan (licence expiry dates are Pakistan calendar dates)
export const startOfToday = () => pkToday();

const base = {
  name: z.string().trim().min(2, 'Name is required').max(100),
  email,
  password,
  phone: phone.optional(),
};

// Discriminated by role. ADMIN cannot self-register. Households cannot register as donors.
export const registerSchema = z.discriminatedUnion('role', [
  z.object({
    ...base,
    role: z.literal('DONOR'),
    donorType: z.enum(['RESTAURANT', 'MARQUEE_CATERER'], { errorMap: () => ({ message: NOT_A_DONOR_MESSAGE }) }),
    organisation: donorOrganisation,
  }),
  z.object({
    ...base,
    role: z.literal('NGO'),
    organisation: ngoOrganisation,
  }),
  z.object({
    ...base,
    role: z.literal('VOLUNTEER'),
    volunteer: z
      .object({
        availability: z.string().trim().max(200).optional(),
        serviceArea: z.string().trim().max(100).optional(),
      })
      .optional(),
  }),
]).superRefine((data, ctx) => {
  const expires = data.organisation?.licenceExpiresOn;
  if (data.role === 'DONOR' && expires && expires < startOfToday()) {
    ctx.addIssue({ code: 'custom', path: ['organisation', 'licenceExpiresOn'], message: 'This food licence has already expired' });
  }
  if (data.role === 'NGO') for (const e of ngoRuleErrors(data.organisation)) ctx.addIssue({ code: 'custom', ...e });
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required'),
});

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    phone: phone.optional().nullable(),
    organisation: organisation
      .extend({
        licenceNumber: licence.licenceNumber,
        licenceAuthority: z.string().trim().min(3).max(100),
        licenceExpiresOn: z.coerce.date().nullable(),
        ngoType: z.enum(NGO_TYPES),
        dailyCapacity: z.number().int().min(1).max(100000),
        beneficiaries: z.number().int().min(1).max(100000),
        serviceRadiusKm: z.number().min(0.5).max(200),
        showInDirectory: z.boolean(),
        contactPhone: phone.nullable(),
        contactEmail: email.nullable(),
        description: z.string().trim().max(500).nullable(),
      })
      .partial()
      .optional(),
    volunteer: z.object({ availability: z.string().trim().max(200).optional(), serviceArea: z.string().trim().max(100).optional() }).optional(),
  })
  .strict();

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: password })
  .refine((d) => d.currentPassword !== d.newPassword, { message: 'New password must be different', path: ['newPassword'] });

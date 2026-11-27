// M1 Access and Accounts
import bcrypt from 'bcryptjs';
import { prisma, TX_OPTIONS } from '../../lib/prisma.js';
import { conflict, unauthorized, forbidden, badRequest } from '../../lib/errors.js';
import { publicUser, isVerified } from '../../lib/access.js';
import { notifyUsers, adminUserIds } from '../../lib/notify.js';
import { signToken, USER_INCLUDE } from '../../middleware/auth.js';
import { withAreaFallback } from '../../lib/areas.js';
import { startOfToday, ngoRuleErrors } from './access.schemas.js';

const BCRYPT_ROUNDS = 10;

/** On profile edits: a new area without a map point moves the point to the area's centre. */
function areaChange(loc) {
  if (loc.area === undefined) return loc;
  if (loc.latitude != null && loc.longitude != null) return withAreaFallback(loc);
  return withAreaFallback({ ...loc, latitude: null, longitude: null });
}

function profileView(user) {
  return { ...publicUser(user), verified: isVerified(user) };
}

export async function register(data) {
  const exists = await prisma.user.findUnique({ where: { email: data.email } });
  if (exists) throw conflict('An account with this email already exists');

  const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

  const user = await prisma.$transaction(async (tx) => {
    let organisationId = null;
    if (data.role === 'NGO' || data.role === 'DONOR') {
      const type = data.role === 'NGO' ? 'NGO' : data.donorType;
      const org = withAreaFallback(data.organisation);
      const shared = { name: org.name, type, address: org.address, area: org.area, latitude: org.latitude ?? null, longitude: org.longitude ?? null };
      // NGO contacts may become public (directory), so they are never filled in from the
      // personal account; a donor business's contact defaults to the account holder.
      const extra =
        type === 'NGO'
          ? {
              ngoType: org.ngoType, dailyCapacity: org.dailyCapacity, beneficiaries: org.beneficiaries, serviceRadiusKm: org.serviceRadiusKm,
              description: org.description ?? null, showInDirectory: org.showInDirectory,
              contactPhone: org.contactPhone ?? null, contactEmail: org.contactEmail ?? null,
            }
          : {
              licenceNumber: org.licenceNumber, licenceAuthority: org.licenceAuthority, licenceExpiresOn: org.licenceExpiresOn ?? null,
              contactPhone: org.contactPhone ?? data.phone ?? null, contactEmail: org.contactEmail ?? data.email,
            };
      if (extra.licenceNumber) {
        const taken = await tx.organisation.findFirst({ where: { licenceAuthority: extra.licenceAuthority, licenceNumber: extra.licenceNumber } });
        if (taken) throw conflict('A business with this food licence number is already registered');
      }
      const created = await tx.organisation.create({ data: { ...shared, ...extra } });
      organisationId = created.id;
    }

    const u = await tx.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash,
        phone: data.phone,
        role: data.role,
        donorType: data.role === 'DONOR' ? data.donorType : null,
        organisationId,
      },
    });

    if (data.role === 'VOLUNTEER') {
      await tx.volunteerProfile.create({ data: { userId: u.id, ...(data.volunteer || {}) } });
    }

    await notifyUsers(tx, await adminUserIds(tx), {
      type: 'VERIFICATION_NEEDED',
      message:
        data.role === 'DONOR'
          ? `New donor business "${data.organisation.name}" (food licence ${data.organisation.licenceNumber}) is waiting for verification. Check the licence before approving.`
          : `New ${data.role.toLowerCase()} account "${data.name}" is waiting for verification.`,
      link: '/admin/verifications',
    });

    return tx.user.findUnique({ where: { id: u.id }, include: USER_INCLUDE });
  }, TX_OPTIONS);

  return { token: signToken(user), user: profileView(user) };
}

export async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email }, include: USER_INCLUDE });
  // Same message for "no such user" and "wrong password" so attackers cannot probe emails
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) throw unauthorized('Incorrect email or password');
  if (!user.active) throw forbidden('Your account has been deactivated. Contact an administrator.');
  return { token: signToken(user), user: profileView(user) };
}

export function me(user) {
  return profileView(user);
}

const LICENCE_FIELDS = ['licenceNumber', 'licenceAuthority', 'licenceExpiresOn'];
const NGO_FIELDS = ['ngoType', 'dailyCapacity', 'beneficiaries', 'serviceRadiusKm', 'description', 'showInDirectory'];
const sameValue = (a, b) => (a instanceof Date || b instanceof Date ? a?.getTime?.() === b?.getTime?.() : a === b);

export async function updateMe(user, data) {
  await prisma.$transaction(async (tx) => {
    if (data.name !== undefined || data.phone !== undefined) {
      await tx.user.update({ where: { id: user.id }, data: { name: data.name, phone: data.phone } });
    }
    if (data.organisation) {
      if (!user.organisationId) throw badRequest('You do not belong to an organisation');
      const isNgo = user.organisation.type === 'NGO';
      const changes = areaChange(data.organisation);
      const wrong = (isNgo ? LICENCE_FIELDS : NGO_FIELDS).filter((f) => changes[f] !== undefined);
      if (wrong.length) throw badRequest(`${isNgo ? 'NGOs' : 'Donor businesses'} cannot set: ${wrong.join(', ')}`);
      if (isNgo) {
        const errors = ngoRuleErrors({ ...user.organisation, ...changes });
        if (errors.length) throw badRequest(errors[0].message);
      }

      // A changed food licence must be checked again by an admin before the business can donate
      const licenceChanged = !isNgo && LICENCE_FIELDS.some((f) => changes[f] !== undefined && !sameValue(changes[f], user.organisation[f]));
      if (licenceChanged && changes.licenceExpiresOn && changes.licenceExpiresOn < startOfToday()) {
        throw badRequest('This food licence has already expired');
      }
      await tx.organisation.update({
        where: { id: user.organisationId },
        data: { ...changes, ...(licenceChanged ? { verificationStatus: 'PENDING' } : {}) },
      });
      if (licenceChanged) {
        await notifyUsers(tx, await adminUserIds(tx), {
          type: 'VERIFICATION_NEEDED',
          message: `"${user.organisation.name}" updated its food licence and must be verified again before it can donate.`,
          link: '/admin/verifications',
        });
      }
    }
    if (data.volunteer) {
      if (!user.volunteerProfile) throw badRequest('You are not a volunteer');
      await tx.volunteerProfile.update({ where: { userId: user.id }, data: data.volunteer });
    }
  }, TX_OPTIONS);
  const fresh = await prisma.user.findUnique({ where: { id: user.id }, include: USER_INCLUDE });
  return profileView(fresh);
}

export async function changePassword(user, { currentPassword, newPassword }) {
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw badRequest('Current password is incorrect');
  const updated = await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) } });
  // Every older token is now invalid (see passwordStamp); hand this device a fresh one
  return { message: 'Password changed. You have been logged out on your other devices.', token: signToken(updated) };
}

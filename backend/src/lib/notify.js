// In-app notifications (FR13). The front-end polls GET /api/notifications.

/** Notify a list of user ids (duplicates and nulls are ignored). */
export async function notifyUsers(tx, userIds, { type, message, link = null }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;
  await tx.notification.createMany({ data: ids.map((userId) => ({ userId, type, message, link })) });
}

/** All active users who belong to an organisation (e.g. every NGO staff account). */
export async function orgUserIds(tx, organisationId) {
  if (!organisationId) return [];
  const users = await tx.user.findMany({ where: { organisationId, active: true }, select: { id: true } });
  return users.map((u) => u.id);
}

/** The user(s) who should hear about things happening to a listing (its donor side). */
export async function listingDonorUserIds(tx, listing) {
  const ids = await orgUserIds(tx, listing.organisationId);
  return ids.length ? ids : [listing.createdById];
}

export async function adminUserIds(tx) {
  const admins = await tx.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } });
  return admins.map((u) => u.id);
}

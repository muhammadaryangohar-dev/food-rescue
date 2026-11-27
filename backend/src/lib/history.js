// Auditability (NFR6): every status transition writes a StatusHistory row.
// Always call this inside the same transaction as the status change.

export const ENTITY = {
  LISTING: 'LISTING',
  REQUEST: 'REQUEST',
  ALLOCATION: 'ALLOCATION',
  TASK: 'TASK',
  EVENT: 'EVENT',
  REPORT: 'REPORT',
};

export function recordTransition(tx, { entity, entityId, from = null, to, reason = null, actorUserId = null }) {
  return tx.statusHistory.create({
    data: { entity, entityId, fromStatus: from, toStatus: to, reason, actorUserId },
  });
}

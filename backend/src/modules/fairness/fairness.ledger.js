// Fairness ledger (M10, Member 2): how much food each NGO actually RECEIVED recently.
// "Received" = servings recorded at a verified (OTP) delivery handover, so proposed or
// accepted offers that never arrived do not count. Used by the matching engine's
// fairness score and by the fairness page.
//
// Takes `db` so the matching engine can call it with its locked transaction.

export const FAIRNESS_WINDOW_DAYS = 7;

/** Map(ngoId -> servings delivered since `since`). */
export async function receivedByNgo(db, { since, ngoIds = null } = {}) {
  const rows = await db.handoverRecord.findMany({
    where: {
      type: 'DELIVERY',
      recordedAt: { gte: since },
      task: { allocation: { status: 'DELIVERED', ...(ngoIds ? { request: { ngoId: { in: ngoIds } } } : {}) } },
    },
    select: { quantity: true, task: { select: { allocation: { select: { request: { select: { ngoId: true } } } } } } },
  });
  const map = new Map();
  for (const r of rows) {
    const ngoId = r.task.allocation.request.ngoId;
    map.set(ngoId, (map.get(ngoId) || 0) + r.quantity);
  }
  return map;
}

export function windowStart(now = new Date(), days = FAIRNESS_WINDOW_DAYS) {
  return new Date(now.getTime() - days * 24 * 3_600_000);
}

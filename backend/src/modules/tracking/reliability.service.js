// Reliability score (extra feature) for NGOs and volunteers, calculated from history the
// system already records (status_history, allocations, tasks). Nothing new is stored,
// so the score can never disagree with the audit trail.
//
// NGO score: how it answers offers. Accepting is best; rejecting is fine (it frees the
// food quickly, so it counts half); ignoring an offer until it expires is worst
// (the food sat waiting for nobody).
//   score = 100 x (accepted + 0.5 x rejected) / (accepted + rejected + unanswered)
//
// Volunteer score: does it deliver what it claims?
//   score = 100 x delivered / claims - 10 per no-show - 15 per late (failed) delivery
//
// Fewer than MIN_EVENTS decisions or claims gives score null and level NEW, so one bad
// day does not label a newcomer. Fatima's fairness module can reuse these numbers.
import { prisma } from '../../lib/prisma.js';
import { forbidden } from '../../lib/errors.js';

export const MIN_EVENTS = 3;

function level(score) {
  if (score === null) return 'NEW';
  if (score >= 85) return 'EXCELLENT';
  if (score >= 65) return 'GOOD';
  if (score >= 40) return 'FAIR';
  return 'POOR';
}
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

export async function ngoReliability({ organisationIds } = {}) {
  const ngos = await prisma.organisation.findMany({
    where: { type: 'NGO', ...(organisationIds ? { id: { in: organisationIds } } : {}) },
    select: { id: true, name: true, area: true, verificationStatus: true },
    orderBy: { name: 'asc' },
  });
  const decisions = await prisma.$queryRaw`
    SELECT r.ngo_id AS id,
      COUNT(*) FILTER (WHERE h.to_status = 'ACCEPTED')::int AS accepted,
      COUNT(*) FILTER (WHERE h.to_status = 'REJECTED')::int AS rejected,
      COUNT(*) FILTER (WHERE h.to_status = 'EXPIRED')::int  AS unanswered
    FROM status_history h
    JOIN allocations a ON a.id = h.entity_id
    JOIN ngo_requests r ON r.id = a.request_id
    WHERE h.entity = 'ALLOCATION' AND h.from_status = 'PROPOSED' AND h.to_status IN ('ACCEPTED', 'REJECTED', 'EXPIRED')
    GROUP BY r.ngo_id`;
  const received = await prisma.$queryRaw`
    SELECT r.ngo_id AS id, COALESCE(SUM(a.quantity - a.lost_quantity), 0)::int AS servings
    FROM allocations a JOIN ngo_requests r ON r.id = a.request_id
    WHERE a.status = 'DELIVERED'
    GROUP BY r.ngo_id`;
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const servings = new Map(received.map((r) => [r.id, r.servings]));

  return ngos.map((n) => {
    const d = byId.get(n.id) ?? { accepted: 0, rejected: 0, unanswered: 0 };
    const decided = d.accepted + d.rejected + d.unanswered;
    const score = decided >= MIN_EVENTS ? clamp((100 * (d.accepted + 0.5 * d.rejected)) / decided) : null;
    return {
      organisationId: n.id,
      name: n.name,
      area: n.area,
      verificationStatus: n.verificationStatus,
      score,
      level: level(score),
      offers: { accepted: d.accepted, rejected: d.rejected, unanswered: d.unanswered },
      servingsReceived: servings.get(n.id) ?? 0,
      explanation:
        score === null
          ? `Not enough history yet (${decided} of ${MIN_EVENTS} offers answered or expired).`
          : `Accepted ${d.accepted}, rejected ${d.rejected} and ignored ${d.unanswered} of ${decided} offers.`,
    };
  });
}

export async function volunteerReliability({ userIds } = {}) {
  const volunteers = await prisma.volunteerProfile.findMany({
    where: userIds ? { userId: { in: userIds } } : {},
    select: { id: true, userId: true, noShowCount: true, approvalStatus: true, user: { select: { name: true } } },
    orderBy: { user: { name: 'asc' } },
  });
  const claims = await prisma.$queryRaw`
    SELECT actor_user_id AS "userId",
      COUNT(*) FILTER (WHERE from_status = 'OPEN' AND to_status = 'CLAIMED')::int AS claimed,
      COUNT(*) FILTER (WHERE from_status = 'CLAIMED' AND to_status = 'OPEN')::int AS released
    FROM status_history
    WHERE entity = 'TASK' AND actor_user_id IS NOT NULL
    GROUP BY actor_user_id`;
  const outcomes = await prisma.$queryRaw`
    SELECT t.volunteer_id AS "volunteerId",
      COUNT(*) FILTER (WHERE t.status = 'DELIVERED')::int AS delivered,
      COUNT(*) FILTER (WHERE a.status = 'FAILED')::int AS failed
    FROM rescue_tasks t JOIN allocations a ON a.id = t.allocation_id
    WHERE t.volunteer_id IS NOT NULL
    GROUP BY t.volunteer_id`;
  const claimMap = new Map(claims.map((c) => [c.userId, c]));
  const outMap = new Map(outcomes.map((o) => [o.volunteerId, o]));

  return volunteers.map((v) => {
    const c = claimMap.get(v.userId) ?? { claimed: 0, released: 0 };
    const o = outMap.get(v.id) ?? { delivered: 0, failed: 0 };
    const score =
      c.claimed >= MIN_EVENTS ? clamp((100 * o.delivered) / c.claimed - 10 * v.noShowCount - 15 * o.failed) : null;
    return {
      volunteerId: v.id,
      userId: v.userId,
      name: v.user.name,
      approvalStatus: v.approvalStatus,
      score,
      level: level(score),
      tasks: { claimed: c.claimed, delivered: o.delivered, releasedByVolunteer: c.released, lateDeliveries: o.failed, noShows: v.noShowCount },
      explanation:
        score === null
          ? `Not enough history yet (${c.claimed} of ${MIN_EVENTS} claims).`
          : `Delivered ${o.delivered} of ${c.claimed} claimed tasks; ${v.noShowCount} no-show(s), ${o.failed} late delivery(ies).`,
    };
  });
}

/** Admin list, sorted lowest score first (the ones to follow up), NEW at the end. */
export async function reliabilityReport(role) {
  const rows = role === 'NGO' ? await ngoReliability() : await volunteerReliability();
  return rows.sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
}

/** A user's own score: NGO staff see their NGO's, volunteers their own. */
export async function myReliability(user) {
  if (user.role === 'NGO') return (await ngoReliability({ organisationIds: [user.organisationId] }))[0] ?? null;
  if (user.role === 'VOLUNTEER') return (await volunteerReliability({ userIds: [user.id] }))[0] ?? null;
  throw forbidden('Reliability scores exist for NGOs and volunteers only');
}

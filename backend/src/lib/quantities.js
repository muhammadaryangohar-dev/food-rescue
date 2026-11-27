// Derived quantities (NFR10: "remaining quantity is calculated, never stored, so no
// counter can drift"). Only SurplusListing.confirmedQuantity and
// NGORequest.requestedQuantity are stored; everything else comes from Allocation rows.
//
// Which allocation statuses hold food?
//   For a LISTING, food is gone once it is proposed, accepted, picked up, delivered,
//   or failed after pickup. REJECTED / EXPIRED / CANCELLED allocations release their
//   food automatically, simply because they stop being counted.
//   For a REQUEST, a FAILED allocation does NOT satisfy the need (the NGO never got
//   the food), so the need opens up again.

export const LISTING_HOLDING = ['PROPOSED', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'FAILED'];
export const REQUEST_COVERING = ['PROPOSED', 'ACCEPTED', 'PICKED_UP', 'DELIVERED'];
export const IN_PROGRESS = ['PROPOSED', 'ACCEPTED', 'PICKED_UP'];
export const RELEASABLE = ['PROPOSED', 'ACCEPTED']; // food not yet collected

function emptyListingQty(confirmed) {
  return { confirmed, committed: 0, remaining: confirmed, delivered: 0, lost: 0, inProgress: 0 };
}

/** Quantities for many listings at once. listings: [{id, confirmedQuantity}] → Map(id → qty) */
export async function listingQuantities(tx, listings) {
  const map = new Map(listings.map((l) => [l.id, emptyListingQty(l.confirmedQuantity)]));
  if (listings.length === 0) return map;
  const groups = await tx.allocation.groupBy({
    by: ['listingId', 'status'],
    where: { listingId: { in: listings.map((l) => l.id) } },
    _sum: { quantity: true, lostQuantity: true },
  });
  for (const g of groups) {
    const q = map.get(g.listingId);
    const qty = g._sum.quantity || 0;
    const lost = g._sum.lostQuantity || 0;
    if (LISTING_HOLDING.includes(g.status)) q.committed += qty;
    if (IN_PROGRESS.includes(g.status)) q.inProgress += qty;
    if (g.status === 'DELIVERED') q.delivered += qty - lost;
    if (g.status === 'DELIVERED' || g.status === 'PICKED_UP') q.lost += lost;
    if (g.status === 'FAILED') q.lost += qty;
  }
  for (const q of map.values()) q.remaining = Math.max(0, q.confirmed - q.committed);
  return map;
}

export async function listingQuantity(tx, listing) {
  return (await listingQuantities(tx, [listing])).get(listing.id);
}

/** Quantities for many requests. requests: [{id, requestedQuantity}] → Map(id → qty) */
export async function requestQuantities(tx, requests) {
  const map = new Map(
    requests.map((r) => [r.id, { requested: r.requestedQuantity, covered: 0, remainingNeed: r.requestedQuantity, delivered: 0, inProgress: 0 }]),
  );
  if (requests.length === 0) return map;
  const groups = await tx.allocation.groupBy({
    by: ['requestId', 'status'],
    where: { requestId: { in: requests.map((r) => r.id) } },
    _sum: { quantity: true, lostQuantity: true },
  });
  for (const g of groups) {
    const q = map.get(g.requestId);
    const net = (g._sum.quantity || 0) - (g._sum.lostQuantity || 0);
    if (REQUEST_COVERING.includes(g.status)) q.covered += net;
    if (IN_PROGRESS.includes(g.status)) q.inProgress += net;
    if (g.status === 'DELIVERED') q.delivered += net;
  }
  for (const q of map.values()) q.remainingNeed = Math.max(0, q.requested - q.covered);
  return map;
}

export async function requestQuantity(tx, request) {
  return (await requestQuantities(tx, [request])).get(request.id);
}

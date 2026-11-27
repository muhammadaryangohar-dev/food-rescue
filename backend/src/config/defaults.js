// Default values for SystemConfig (proposal: "rules, thresholds and weights are
// default design values ... kept configurable"). The seed copies these into the
// system_config table; admins change them from the configuration panel.
export const CONFIG_DEFAULTS = {
  // ---- Allocations / rescue (Member 1)
  OFFER_RESPONSE_MINUTES: { value: '30', description: 'Minutes an NGO has to accept or reject a proposed offer' },
  PICKUP_WINDOW_MINUTES: { value: '120', description: 'Minutes after acceptance within which food must be picked up (capped by collection deadline)' },
  CLAIM_WINDOW_MINUTES: { value: '45', description: 'Minutes a volunteer has to pick up after claiming a task before the claim is released' },
  OTP_MAX_ATTEMPTS: { value: '5', description: 'Wrong OTP attempts before a rescue task is locked' },
  MIN_ALLOCATION_SERVINGS: { value: '5', description: 'Smallest allocation the engine will create (servings)' },
  SWEEP_MIN_INTERVAL_SECONDS: { value: '15', description: 'Minimum seconds between expire-on-read checks' },
  VOLUNTEER_NO_SHOW_LIMIT: { value: '3', description: 'No-shows after which a volunteer can no longer claim tasks' },

  // ---- Matching (Member 2 reads these)
  NEAR_EXPIRY_HOURS: { value: '2', description: 'Below this many hours to safe-until, the near-expiry rule applies' },
  NEAR_EXPIRY_RADIUS_KM: { value: '5', description: 'Max distance for near-expiry food' },
  AVERAGE_SPEED_KMH: { value: '25', description: 'Average travel speed for arrival estimates' },
  WEIGHT_FRESHNESS: { value: '30', description: 'Score weight: freshness' },
  WEIGHT_FEASIBILITY: { value: '25', description: 'Score weight: collection feasibility' },
  WEIGHT_QUANTITY_FIT: { value: '20', description: 'Score weight: quantity fit' },
  WEIGHT_PROXIMITY: { value: '15', description: 'Score weight: proximity' },
  WEIGHT_FAIRNESS: { value: '10', description: 'Score weight: fairness' },
};

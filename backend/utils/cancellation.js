/**
 * CENTRALISED CANCELLATION POLICY  (backend/utils/cancellation.js)
 *
 * The cancellation fine used to be described in prose and then re-implemented
 * (differently) in every route that cancelled something. This module is the one
 * place the rules live, and every number is environment-configurable so the
 * percentage or the flat amount can be changed without touching code.
 *
 *   CANCEL_FREE_WINDOW_HOURS     no penalty when cancelling this long before the start
 *   CANCEL_FEE_PERCENT_*         percentage of the paid amount kept as a penalty
 *   CANCEL_FEE_FLAT_*            flat rupee penalty (capped by CANCEL_FEE_MAX_*)
 *   CANCEL_FEE_MAX_*             hard ceiling for the penalty, 0 = no ceiling
 *   CANCEL_OWNER_PENALTY_MULTIPLIER  owner-caused cancellations can cost more
 *
 * Money never disappears: whatever is not refunded to the customer is always
 * described as platform fee, owner compensation or cancellation fee, so the
 * numbers in the UI, the API and the database add up.
 */

const DEFAULT_POLICY = {
  freeWindowHours: 6,
  feePercent: { user: 10, owner: 25, admin: 0 },
  feeFlat: { user: 0, owner: 0, admin: 0 },
  feeMax: { user: 1500, owner: 2500, admin: 0 },
  ownerPenaltyMultiplier: 1
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** Reads the live policy from the environment. Called per request, never cached. */
function loadPolicy() {
  const env = process.env;
  return {
    freeWindowHours: Math.max(0, num(env.CANCEL_FREE_WINDOW_HOURS, DEFAULT_POLICY.freeWindowHours)),
    feePercent: {
      user: clamp(num(env.CANCEL_FEE_PERCENT_USER, DEFAULT_POLICY.feePercent.user), 0, 100),
      owner: clamp(num(env.CANCEL_FEE_PERCENT_OWNER, DEFAULT_POLICY.feePercent.owner), 0, 100),
      admin: clamp(num(env.CANCEL_FEE_PERCENT_ADMIN, DEFAULT_POLICY.feePercent.admin), 0, 100)
    },
    feeFlat: {
      user: Math.max(0, num(env.CANCEL_FEE_FLAT_USER, DEFAULT_POLICY.feeFlat.user)),
      owner: Math.max(0, num(env.CANCEL_FEE_FLAT_OWNER, DEFAULT_POLICY.feeFlat.owner)),
      admin: Math.max(0, num(env.CANCEL_FEE_FLAT_ADMIN, DEFAULT_POLICY.feeFlat.admin))
    },
    feeMax: {
      user: Math.max(0, num(env.CANCEL_FEE_MAX_USER, DEFAULT_POLICY.feeMax.user)),
      owner: Math.max(0, num(env.CANCEL_FEE_MAX_OWNER, DEFAULT_POLICY.feeMax.owner)),
      admin: Math.max(0, num(env.CANCEL_FEE_MAX_ADMIN, DEFAULT_POLICY.feeMax.admin))
    },
    ownerPenaltyMultiplier: Math.max(0, num(env.CANCEL_OWNER_PENALTY_MULTIPLIER, DEFAULT_POLICY.ownerPenaltyMultiplier)),
    platformFeePercent: clamp(num(env.PLATFORM_FEE_PERCENT, 10), 0, 100)
  };
}

function normalizeActor(actor) {
  const value = String(actor || '').toLowerCase();
  return ['user', 'owner', 'admin'].includes(value) ? value : 'user';
}

/**
 * @param {object} input
 * @param {number} input.amount          the amount the customer actually paid
 * @param {string} input.actor           'user' | 'owner' | 'admin'
 * @param {Date}   [input.startsAt]      departure / rental start
 * @param {Date}   [input.cancelledAt]   defaults to now
 * @param {string} [input.reason]
 * @param {string} [input.flow]          'rental' | 'ride'
 * @param {number} [input.platformFee]   fee already retained on this record
 */
function computeCancellation({ amount, actor, startsAt, cancelledAt = new Date(), reason = '', flow = 'rental', platformFee }) {
  const policy = loadPolicy();
  const who = normalizeActor(actor);
  const originalAmount = roundMoney(Math.max(0, num(amount, 0)));
  const when = cancelledAt instanceof Date && !Number.isNaN(cancelledAt.getTime()) ? cancelledAt : new Date();
  const start = startsAt ? new Date(startsAt) : null;
  const hasStart = Boolean(start) && !Number.isNaN(start.getTime());

  const hoursToStart = hasStart ? (start.getTime() - when.getTime()) / 3600000 : null;
  // A free window of 0 hours means "no free window at all" (the fee always
  // applies). Treating it as "always free" would make the fee uncollectable just
  // by setting the window to zero, which is exactly the kind of configuration
  // trap this module exists to remove.
  const withinFreeWindow = policy.freeWindowHours > 0 && hasStart && hoursToStart >= policy.freeWindowHours;

  const percent = policy.feePercent[who];
  const flat = policy.feeFlat[who];
  const ceiling = policy.feeMax[who];

  let fee = 0;
  if (originalAmount > 0 && !withinFreeWindow) {
    fee = roundMoney(originalAmount * (percent / 100) + flat);
    if (ceiling > 0) fee = Math.min(fee, ceiling);
    fee = Math.min(fee, originalAmount);
  }

  // An owner-caused cancellation can be scaled up by configuration (for example
  // when the owner cancels repeatedly), but never beyond what was paid.
  if (who === 'owner' && policy.ownerPenaltyMultiplier !== 1) {
    fee = roundMoney(Math.min(originalAmount, fee * policy.ownerPenaltyMultiplier));
  }

  const refundAmount = roundMoney(Math.max(0, originalAmount - fee));
  const retainedByPlatform = fee;
  const retainedFeePercent = originalAmount > 0 ? roundMoney((fee / originalAmount) * 100) : 0;

  return {
    flow,
    cancelledBy: who,
    cancelledAt: when,
    reason: String(reason || '').slice(0, 500),
    originalAmount,
    cancellationFee: fee,
    cancellationFeePercent: percent,
    refundAmount,
    finalAmount: refundAmount,
    retainedByPlatform,
    platformFee: platformFee === undefined ? roundMoney(originalAmount * (policy.platformFeePercent / 100)) : roundMoney(platformFee),
    freeWindowHours: policy.freeWindowHours,
    withinFreeWindow: Boolean(withinFreeWindow),
    hoursToStart: hasStart ? roundMoney(hoursToStart) : null,
    policyVersion: 'revex-cancellation-v1',
    explanation: explain({ who, originalAmount, fee, refundAmount, withinFreeWindow: Boolean(withinFreeWindow), freeWindowHours: policy.freeWindowHours, hasStart, flow })
  };
}

function explain({ who, originalAmount, fee, refundAmount, withinFreeWindow, freeWindowHours, hasStart, flow }) {
  const noun = flow === 'ride' ? 'ride booking' : 'rental booking';
  if (originalAmount <= 0) return `No payment was collected for this ${noun}, so there is nothing to refund.`;
  if (withinFreeWindow) {
    return `Cancelled more than ${freeWindowHours} hour(s) before the start, so no cancellation fee applies. Full refund of the amount paid.`;
  }
  if (fee <= 0) return `This ${noun} was cancelled by the ${who} and the platform policy charges no fee. Full refund of the amount paid.`;
  const actorLabel = who === 'user' ? 'customer' : who === 'owner' ? 'owner' : 'administrator';
  return `Cancelled by the ${actorLabel}${hasStart ? ' after the free-cancellation window' : ''}. A cancellation fee is retained and the balance is refunded.`;
}

/**
 * Refund line for a payment record. Razorpay is called for real by the route;
 * this only describes the amounts so the API, the database and the UI agree.
 */
function refundPlan({ amount, fee, method }) {
  const paid = roundMoney(Math.max(0, num(amount, 0)));
  const penalty = roundMoney(Math.max(0, num(fee, 0)));
  const refund = roundMoney(Math.max(0, paid - penalty));
  const isGateway = String(method || '') === 'razorpay';
  return {
    amount: paid,
    cancellationFee: penalty,
    refundAmount: refund,
    refundable: refund > 0,
    channel: isGateway ? 'razorpay' : 'manual',
    note: isGateway
      ? (refund > 0 ? 'Refund requested from Razorpay.' : 'No refund is due; the full amount is retained as the cancellation fee.')
      : 'No payment gateway is attached to this record, so the refund is recorded for manual processing.'
  };
}

module.exports = { DEFAULT_POLICY, loadPolicy, computeCancellation, refundPlan, roundMoney, normalizeActor };

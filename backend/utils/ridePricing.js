/**
 * RIDE PRICING  (backend/utils/ridePricing.js)
 *
 * Find Ride had three different "totals": the card showed `seats × price`, the
 * booking panel recomputed it from a hidden input, and the backend stored a
 * third value. This module is the single definition of what a rider pays, and
 * both the API and the UI derive their numbers from it.
 *
 *   Base ride price          seats x farePerSeat
 * + Platform fee            PLATFORM_FEE_PERCENT (configurable)
 * + Applicable extras       ride.additionalCharges (e.g. toll / pickup fee)
 * - Discount                ride.discountPercent
 * ------------------------------------------------------------
 * = Final payable amount
 *
 * The backend ALWAYS recomputes this from the stored Ride document. The
 * browser may send `seats` and nothing else; any amount it sends is ignored.
 */
const { roundMoney } = require('./pricing');

const MAX_SEATS = 6;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function platformFeePercent() {
  return clamp(num(process.env.PLATFORM_FEE_PERCENT, 10), 0, 100);
}

/** Commission retained by the platform on a completed ride. */
const OWNER_SHARE_RATE = 0.9;

function ownerShare(amount) {
  return roundMoney(num(amount, 0) * OWNER_SHARE_RATE);
}

/**
 * @param {object} ride    the stored Ride document (price, additionalCharges, discountPercent)
 * @param {number} seats   seats the rider is buying
 * @returns {object} a full, display-ready breakdown
 */
function calculateRideQuote(ride = {}, seats = 1) {
  const seatCount = clamp(Math.trunc(num(seats, 1)), 1, MAX_SEATS);
  const farePerSeat = Math.max(0, num(ride.price, 0));
  const baseRideAmount = roundMoney(farePerSeat * seatCount);
  const additionalCharges = Math.max(0, num(ride.additionalCharges, 0));
  const discountPercent = clamp(num(ride.discountPercent, 0), 0, 100);
  const feePercent = platformFeePercent();

  const subtotal = roundMoney(baseRideAmount + additionalCharges);
  const platformFee = roundMoney(subtotal * (feePercent / 100));
  const withFee = roundMoney(subtotal + platformFee);
  const discountAmount = roundMoney(withFee * (discountPercent / 100));
  const grandTotal = roundMoney(Math.max(0, withFee - discountAmount));
  const ownerShareAmount = ownerShare(grandTotal);

  return {
    currency: 'INR',
    price: roundMoney(farePerSeat),
    priceLabel: 'per seat',
    seats: seatCount,
    baseRideAmount,
    additionalCharges,
    platformFee,
    platformFeePercent: feePercent,
    discountPercent,
    discountAmount,
    subtotal,
    grandTotal,
    payableAmount: grandTotal,
    ownerShare: ownerShareAmount,
    platformEarnings: roundMoney(grandTotal - ownerShareAmount),
    ownerShareRate: OWNER_SHARE_RATE,
    formula: `${seatCount} seat(s) × ₹${roundMoney(farePerSeat)}${additionalCharges ? ` + ₹${additionalCharges} extras` : ''} + ${feePercent}% platform fee${discountPercent ? ` − ${discountPercent}% discount` : ''}`,
    pricingVersion: 'revex-ride-pricing-v1'
  };
}

/**
 * Seats still bookable on a ride, given the seats consumed by active bookings.
 * The authoritative check runs in the route with a guarded atomic update; this
 * helper is the pure calculation used by the API and the tests.
 */
function availableSeats({ totalSeats, bookedSeats }) {
  return Math.max(0, Math.trunc(num(totalSeats, 0)) - Math.trunc(num(bookedSeats, 0)));
}

/* ------------------------------------------------- partial (smart) pricing */

/**
 * SMART ROUTE PRICING
 *
 * An owner's `price` is the fare for one seat over the WHOLE route. A rider who
 * joins that route halfway travels only part of it, so they owe the same share
 * of the same distance:
 *
 *     fare per seat = price x riderKm / totalKm
 *
 * Rounded to the nearest rupee and floored at Rs 1, so a real leg never rounds
 * down to "free".
 *
 * This lives here, next to calculateRideQuote, rather than in the route or the
 * client, for one reason: the quote screen, the Razorpay order and the stored
 * booking total must be produced by the SAME arithmetic. Splitting it is how a
 * booking ends up charging a different number from the one that was displayed.
 */
function partialFarePerSeat(ride = {}, plan = {}) {
  const price = Math.max(0, num(ride.price, 0));
  const totalKm = num(plan.totalKm, 0);
  // No usable route, or the rider takes the whole thing: the normal price.
  if (!(totalKm > 0) || plan.mode !== 'partial' && plan.mode !== 'pin') {
    return { farePerSeat: roundMoney(price), proportional: false, wholeRoute: true, fraction: 1 };
  }
  const fraction = clamp(num(plan.fraction, 1), 0, 1);
  return {
    farePerSeat: Math.max(1, roundMoney(price * fraction)),
    proportional: true,
    wholeRoute: false,
    fraction
  };
}

/**
 * Toll / pickup extras are charged for the road actually used, so they are scaled
 * by the same fraction as the fare. A rider covering 40% of the route should not
 * pay 100% of the toll.
 */
function partialAdditionalCharges(ride = {}, plan = {}) {
  const charges = Math.max(0, num(ride.additionalCharges, 0));
  if (!charges) return 0;
  if (plan.mode !== 'partial' && plan.mode !== 'pin') return roundMoney(charges);
  return roundMoney(charges * clamp(num(plan.fraction, 1), 0, 1));
}

/**
 * The quote for a rider who joins part-way along the route.
 *
 * It reuses calculateRideQuote for everything after the two prorated inputs, so
 * the platform fee, the discount, the owner's share and the payable amount are
 * computed by literally the same code as a full-route booking.
 */
function calculatePartialRideQuote(ride = {}, seats = 1, plan = {}) {
  const { farePerSeat, proportional, wholeRoute, fraction } = partialFarePerSeat(ride, plan);
  const prorated = {
    ...ride,
    price: farePerSeat,
    additionalCharges: partialAdditionalCharges(ride, plan)
  };
  const base = calculateRideQuote(prorated, seats);
  const fullRouteFarePerSeat = roundMoney(Math.max(0, num(ride.price, 0)));
  const savedPerSeat = proportional ? roundMoney(Math.max(0, fullRouteFarePerSeat - farePerSeat)) : 0;
  const seatCount = base.seats;

  return {
    ...base,
    price: farePerSeat,
    smart: {
      applied: proportional,
      mode: plan.mode || 'full',
      wholeRoute,
      fraction: Math.round(fraction * 10000) / 10000,
      fullRouteFarePerSeat,
      farePerSeat,
      savedPerSeat,
      savedTotal: roundMoney(savedPerSeat * seatCount),
      riderKm: Math.max(0, Math.round(num(plan.riderKm, 0) * 10) / 10),
      totalKm: Math.max(0, Math.round(num(plan.totalKm, 0) * 10) / 10),
      boardName: String(plan.board?.name || '').slice(0, 120),
      dropName: String(plan.drop?.name || '').slice(0, 120),
      boardAlongKm: Math.max(0, Math.round(num(plan.boardAlongKm, 0) * 10) / 10),
      dropAlongKm: Math.max(0, Math.round(num(plan.dropAlongKm, 0) * 10) / 10),
      pickupDetourKm: Math.max(0, Math.round(num(plan.pickupDetourKm, 0) * 10) / 10),
      dropDetourKm: Math.max(0, Math.round(num(plan.dropDetourKm, 0) * 10) / 10),
      estimated: Boolean(plan.estimated),
      provider: String(plan.provider || '').slice(0, 40)
    },
    pricingVersion: proportional ? 'revex-smart-route-pricing-v1' : 'revex-ride-pricing-v1',
    formula: proportional
      ? `${seatCount} seat(s) x Rs ${farePerSeat} (${smartKm(plan.riderKm)} of ${smartKm(plan.totalKm)} km) + ${base.platformFeePercent}% platform fee${base.discountPercent ? ` - ${base.discountPercent}% discount` : ''}`
      : base.formula
  };
}

function smartKm(value) {
  return `${Math.max(0, Math.round(num(value, 0) * 10) / 10)}`;
}

module.exports = {
  MAX_SEATS,
  OWNER_SHARE_RATE,
  platformFeePercent,
  calculateRideQuote,
  calculatePartialRideQuote,
  partialFarePerSeat,
  partialAdditionalCharges,
  availableSeats,
  ownerShare,
  roundMoney
};

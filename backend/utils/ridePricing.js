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

module.exports = {
  MAX_SEATS,
  OWNER_SHARE_RATE,
  platformFeePercent,
  calculateRideQuote,
  availableSeats,
  ownerShare,
  roundMoney
};

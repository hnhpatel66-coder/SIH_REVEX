const Vehicle = require('../models/Vehicle');
const User = require('../models/User');

// The platform retains a fixed commission on each completed rental.
const OWNER_SHARE_RATE = 0.9;

function ownerShare(amount) {
  return Math.round(Number(amount || 0) * OWNER_SHARE_RATE);
}

/**
 * Applies (direction = 1) or reverses (direction = -1) owner earnings counters.
 *
 * Previously these counters were only ever incremented, so a cancelled or
 * rejected paid booking left the owner's lifetime earnings permanently inflated.
 * Every terminal booking transition must now go through this helper.
 */
async function applyEarningsDelta(booking, direction = 1) {
  const sign = direction >= 0 ? 1 : -1;
  const share = ownerShare(booking.grandTotal ?? booking.totalAmount) * sign;
  const vehicleId = booking.vehicleId?._id || booking.vehicleId;
  const ownerId = booking.ownerId || booking.vehicleId?.ownerId?._id || booking.vehicleId?.ownerId;
  if (!vehicleId) return { share: 0 };

  await Vehicle.findByIdAndUpdate(vehicleId, {
    $inc: { totalEarnings: share, totalRentals: sign }
  });
  // Never let the rental counter go negative.
  await Vehicle.updateOne({ _id: vehicleId, totalRentals: { $lt: 0 } }, { $set: { totalRentals: 0 } });
  if (ownerId) {
    await User.findByIdAndUpdate(ownerId, { $inc: { ownerEarnings: share } });
  }
  return { share };
}

/** True when a booking has previously contributed to owner earnings. */
function hasEarned(status) {
  return status === 'confirmed' || status === 'completed';
}

module.exports = { OWNER_SHARE_RATE, ownerShare, applyEarningsDelta, hasEarned };

/**
 * Hard delete with full referential cleanup.
 *
 * Previously vehicles and users were only SOFT removed (status = 'removed',
 * isActive = false). The records stayed in MongoDB forever, still showed up in
 * admin counts, and still occupied the number-plate unique index. The product
 * requirement is now a REAL delete: the document disappears from every screen
 * and from the database, together with everything that only existed to support
 * it.
 *
 * Every delete therefore removes dependent rows first, in an order that never
 * leaves an orphan behind:
 *
 *   Vehicle -> Payment -> Agreement -> Booking -> Review -> Vehicle
 *   User    -> (their vehicles, via deleteVehicle)
 *            -> RideBooking -> Ride -> Notification -> MonthlyBookingCounter
 *            -> Payment / Agreement / Booking / Review -> User
 */
const Vehicle = require('../models/Vehicle');
const User = require('../models/User');
const Booking = require('../models/Booking');
const Agreement = require('../models/Agreement');
const Payment = require('../models/Payment');
const Review = require('../models/Review');
const Notification = require('../models/Notification');
const Ride = require('../models/Ride');
const RideBooking = require('../models/RideBooking');
const MonthlyBookingCounter = require('../models/MonthlyBookingCounter');

const asId = value => (value && value._id) || value;

/**
 * Permanently removes a vehicle and every record that depends on it.
 * Returns a per-collection breakdown so the UI can tell the user what went.
 */
async function deleteVehicleCascade(vehicleId) {
  const id = asId(vehicleId);
  const vehicle = await Vehicle.findById(id).select('ownerId name numberPlate').lean();
  if (!vehicle) return { deleted: false, reason: 'Vehicle not found.' };

  // Bookings first (we need them to unwind monthly counters and earnings).
  const bookings = await Booking.find({ vehicleId: id }).select('_id userId ownerId status paymentStatus grandTotal totalAmount monthKey monthlySlot').lean();
  const bookingIds = bookings.map(b => b._id);

  const [payments, agreements, reviews, notifications] = await Promise.all([
    Payment.deleteMany({ vehicleId: id }),
    Agreement.deleteMany({ bookingId: { $in: bookingIds } }),
    Review.deleteMany({ vehicleId: id }),
    Notification.deleteMany({ 'data.vehicleId': String(id) })
  ]);

  const bookingResult = await Booking.deleteMany({ vehicleId: id });

  // Free the monthly booking slots those bookings were holding.
  if (bookings.length) {
    const keys = new Set(bookings.filter(b => b.monthKey).map(b => `${b.userId}:${b.monthKey}`));
    for (const key of keys) {
      const [userId, monthKey] = key.split(/:(?!:)/);
      await MonthlyBookingCounter.updateOne(
        { userId, monthKey },
        { $inc: { count: -bookings.filter(b => String(b.userId) === userId && b.monthKey === monthKey).length } }
      );
    }
    await MonthlyBookingCounter.updateMany({ count: { $lt: 1 } }, { $set: { count: 0 } });
  }

  // A deleted vehicle must not leave a stale "removed" tombstone.
  const vehicleResult = await Vehicle.deleteOne({ _id: id });

  return {
    deleted: vehicleResult.deletedCount === 1,
    vehicle: { name: vehicle.name, numberPlate: vehicle.numberPlate },
    counts: {
      bookings: bookingResult.deletedCount || 0,
      agreements: agreements.deletedCount || 0,
      payments: payments.deletedCount || 0,
      reviews: reviews.deletedCount || 0,
      notifications: notifications.deletedCount || 0
    }
  };
}

/**
 * Permanently removes a user: their vehicles, ride offers, ride bookings,
 * notifications, counters and every booking they made or received.
 * Refuses to delete the last remaining admin so the portal cannot be locked out.
 */
async function deleteUserCascade(userId, { allowAdmin = true } = {}) {
  const id = asId(userId);
  const user = await User.findById(id).select('name email role isActive').lean();
  if (!user) return { deleted: false, reason: 'User not found.' };

  if (user.role === 'admin' && !allowAdmin) {
    return { deleted: false, reason: 'Administrator accounts cannot be deleted.' };
  }
  if (user.role === 'admin') {
    const adminCount = await User.countDocuments({ role: 'admin' });
    if (adminCount <= 1) {
      return { deleted: false, reason: 'This is the only administrator account and cannot be deleted.' };
    }
  }

  // 1. Their vehicles (and everything hanging off those vehicles).
  const vehicles = await Vehicle.find({ ownerId: id }).select('_id name numberPlate').lean();
  const vehicleBreakdown = [];
  for (const vehicle of vehicles) {
    const result = await deleteVehicleCascade(vehicle._id);
    if (result.deleted) vehicleBreakdown.push(result);
  }
  const vehicleIds = vehicles.map(v => v._id);

  // 2. Rides they offered, plus anyone who booked a seat.
  const rides = await Ride.find({ driverId: id }).select('_id').lean();
  const rideIds = rides.map(r => r._id);
  const rideBookings = await RideBooking.deleteMany({ rideId: { $in: rideIds } });
  const rideResult = await Ride.deleteMany({ driverId: id });

  // 3. Bookings they took as a renter (their own vehicles are already gone).
  const renterBookings = await Booking.find({ userId: id }).select('_id').lean();
  const renterBookingIds = renterBookings.map(b => b._id);
  const [renterPayments, renterAgreements, renterReviews] = await Promise.all([
    Payment.deleteMany({ userId: id }),
    Agreement.deleteMany({ bookingId: { $in: renterBookingIds } }),
    Review.deleteMany({ userId: id })
  ]);
  const renterBookingResult = await Booking.deleteMany({ userId: id });

  // 4. Stragglers that referenced the vehicle set.
  if (vehicleIds.length) await Review.deleteMany({ vehicleId: { $in: vehicleIds } });

  // 5. Personal data.
  const [notifications, counters] = await Promise.all([
    Notification.deleteMany({ userId: id }),
    MonthlyBookingCounter.deleteMany({ userId: id })
  ]);

  const userResult = await User.deleteOne({ _id: id });

  return {
    deleted: userResult.deletedCount === 1,
    user: { name: user.name, email: user.email, role: user.role },
    vehicles: { total: vehicles.length, removed: vehicleBreakdown.length, items: vehicleBreakdown },
    counts: {
      // Each vehicle is already removed by deleteVehicleCascade, so the
      // removed count is the number of successful vehicle cascades.
      vehicles: vehicleBreakdown.length,
      rides: rideResult.deletedCount || 0,
      rideBookings: rideBookings.deletedCount || 0,
      bookings: renterBookingResult.deletedCount || 0,
      agreements: renterAgreements.deletedCount || 0,
      payments: renterPayments.deletedCount || 0,
      reviews: renterReviews.deletedCount || 0,
      notifications: notifications.deletedCount || 0,
      counters: counters.deletedCount || 0
    }
  };
}

/** Human readable one-line summary for the confirmation toast. */
function summarise(result) {
  if (!result || !result.deleted) return result?.reason || 'Nothing was deleted.';
  const c = result.counts || {};
  const parts = [];
  if (c.bookings) parts.push(`${c.bookings} booking${c.bookings === 1 ? '' : 's'}`);
  if (c.agreements) parts.push(`${c.agreements} agreement${c.agreements === 1 ? '' : 's'}`);
  if (c.payments) parts.push(`${c.payments} payment${c.payments === 1 ? '' : 's'}`);
  if (c.reviews) parts.push(`${c.reviews} review${c.reviews === 1 ? '' : 's'}`);
  if (c.rides) parts.push(`${c.rides} ride offer${c.rides === 1 ? '' : 's'}`);
  if (c.notifications) parts.push(`${c.notifications} notification${c.notifications === 1 ? '' : 's'}`);
  return parts.length ? `Deleted permanently with ${parts.join(', ')}.` : 'Deleted permanently.';
}

module.exports = { deleteVehicleCascade, deleteUserCascade, summarise };

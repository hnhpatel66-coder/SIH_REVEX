const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Ride = require('../models/Ride');
const RideBooking = require('../models/RideBooking');
const Vehicle = require('../models/Vehicle');
const User = require('../models/User');
const Payment = require('../models/Payment');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../utils/notify');
const { normalizeMediaUrl } = require('../utils/media');
const { calculateRideQuote, availableSeats, roundMoney } = require('../utils/ridePricing');
const { computeCancellation, refundPlan } = require('../utils/cancellation');
const gateway = require('../utils/payments');
const {
  RIDE_STATUS, RIDE_STATUS_LABELS, RIDE_BOOKING_STATUS, RIDE_BOOKING_STATUS_LABELS,
  RIDE_BOOKING_ACTIVE_STATUSES, CANCELLED_BY, cancelledStatusFor
} = require('../utils/statuses');

const router = express.Router();

/* ------------------------------------------------------------------ helpers */

function idOf(value) {
  if (!value) return '';
  if (typeof value === 'object') return String(value._id || value.id || '');
  return String(value);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

/**
 * Seat availability read straight from the booking ledger.
 *
 * `Ride.seatsBooked` is a denormalised counter used for the atomic write guard.
 * Reads use this aggregation so a counter that ever drifted (for example after
 * an old manual database edit) can never show a wrong number to a rider.
 */
async function bookedSeatsByRide(rideIds) {
  if (!rideIds.length) return new Map();
  const rows = await RideBooking.aggregate([
    { $match: { rideId: { $in: rideIds }, status: { $in: RIDE_BOOKING_ACTIVE_STATUSES } } },
    { $group: { _id: '$rideId', seats: { $sum: '$seats' } } }
  ]);
  return new Map(rows.map(row => [idOf(row._id), row.seats || 0]));
}

function rideStatusOf(value) {
  return value === 'available' ? RIDE_STATUS.APPROVED : (value || RIDE_STATUS.PENDING);
}

async function serializeRides(rides, { includePrivate = false } = {}) {
  const list = Array.isArray(rides) ? rides : [rides];
  const booked = await bookedSeatsByRide(list.map(ride => ride._id));
  // The driver profile picture is public information (it is shown on the card),
  // so it is resolved once here rather than fetched per card.
  const driverIds = list.map(ride => idOf(ride.driverId)).filter(Boolean);
  const drivers = driverIds.length
    ? await User.find({ _id: { $in: driverIds } }).select('name photo rating isVerified').lean()
    : [];
  const driverMap = Object.fromEntries(drivers.map(driver => [idOf(driver._id), driver]));
  return list.map(ride => {
    const value = ride && typeof ride.toObject === 'function' ? ride.toObject() : { ...(ride || {}) };
    const status = rideStatusOf(value.status);
    const seatsBooked = booked.get(idOf(value._id)) || 0;
    const seatsAvailable = availableSeats({ totalSeats: value.seats, bookedSeats: seatsBooked });
    const driver = driverMap[idOf(value.driverId)];
    const result = {
      ...value,
      id: idOf(value._id || value.id),
      driverId: idOf(value.driverId),
      vehicleId: idOf(value.vehicleId),
      vehicleImage: normalizeMediaUrl(value.vehicleImage, ''),
      driverPhoto: driver?.photo ? normalizeMediaUrl(driver.photo, '') : '',
      driverRating: driver?.rating === undefined ? num(value.rating, 5) : num(driver.rating, 5),
      driverVerified: driver ? driver.isVerified !== false : Boolean(value.verified),
      status,
      statusLabel: RIDE_STATUS_LABELS[status] || 'Pending approval',
      seats: num(value.seats, 0),
      seatsBooked,
      seatsAvailable,
      soldOut: seatsAvailable <= 0,
      bookable: status === RIDE_STATUS.APPROVED && seatsAvailable > 0 && new Date(value.date) >= startOfToday(),
      quote: calculateRideQuote(value, 1),
      additionalCharges: num(value.additionalCharges, 0),
      discountPercent: num(value.discountPercent, 0)
    };
    if (!includePrivate) { delete result.driverPhone; delete result.driverId; }
    return result;
  });
}

function imageValue(value) {
  if (typeof value !== 'string' || !value) return '';
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^\/?(uploads|images|assets)\//i.test(value)) return normalizeMediaUrl(value, '');
  return '';
}

/**
 * Uses the owner's already-registered vehicle photo when the offer is created
 * from that vehicle, so Find Ride shows the SAME image as Rent Vehicle instead of
 * a second, separately uploaded one.
 */
function vehicleImageFor(vehicle, provided) {
  return imageValue(vehicle?.vehiclePicture || vehicle?.image || '') || imageValue(provided);
}

async function recordRidePayment(booking, method, reference, providerData = {}) {
  try {
    await Payment.create({
      rideBookingId: booking._id,
      userId: booking.userId,
      kind: 'ride',
      amount: booking.totalAmount,
      currency: 'INR',
      method: method === 'razorpay' ? 'razorpay' : 'demo',
      status: 'paid',
      reference,
      providerData,
      paidAt: new Date()
    });
  } catch (error) {
    if (error.code !== 11000) console.warn('[rides] payment record sync failed:', error.message);
  }
}

function snapshotOf(ride) {
  return {
    from: ride.from,
    to: ride.to,
    date: ride.date,
    time: ride.time,
    vehicle: ride.vehicle,
    vehicleType: ride.vehicleType,
    fuelType: ride.fuelType,
    numberPlate: ride.numberPlate,
    vehicleImage: normalizeMediaUrl(ride.vehicleImage, ''),
    pricePerSeat: num(ride.price, 0),
    seats: ride.seats,
    driver: ride.driver,
    driverId: idOf(ride.driverId),
    capturedAt: new Date()
  };
}

function serializeBooking(booking) {
  const value = booking && typeof booking.toObject === 'function' ? booking.toObject() : { ...(booking || {}) };
  const ride = value.rideId && typeof value.rideId === 'object' ? value.rideId : null;
  const snapshot = value.rideSnapshot && typeof value.rideSnapshot === 'object' ? value.rideSnapshot : {};
  const user = value.userId && typeof value.userId === 'object' ? value.userId : null;
  const status = value.status || RIDE_BOOKING_STATUS.PAYMENT_PENDING;
  // The photo falls back through: the stored snapshot -> the live ride -> the
  // denormalised copy. It is never dropped after booking.
  const image = normalizeMediaUrl(
    value.vehicleImage || snapshot.vehicleImage || (ride ? ride.vehicleImage : '') || '',
    ''
  );
  return {
    ...value,
    id: idOf(value._id),
    rideId: ride ? { ...ride, id: idOf(ride._id) } : idOf(value.rideId),
    userId: user ? { ...user, id: idOf(user._id) } : idOf(value.userId),
    userName: user?.name || '',
    userEmail: user?.email || '',
    userPhone: user?.phone || '',
    status,
    statusLabel: RIDE_BOOKING_STATUS_LABELS[status] || status,
    vehicleImage: image,
    rideSnapshot: snapshot,
    vehicleName: snapshot.vehicle || ride?.vehicle || '',
    numberPlate: snapshot.numberPlate || ride?.numberPlate || '',
    from: snapshot.from || ride?.from || '',
    to: snapshot.to || ride?.to || '',
    rideDate: snapshot.date || ride?.date || null,
    rideTime: snapshot.time || ride?.time || '',
    quote: value.quote && Object.keys(value.quote).length ? value.quote : calculateRideQuote(ride || snapshot, value.seats),
    cancellation: value.cancellation || null,
    refund: value.refund || null
  };
}

/** Releases seats back to a ride. Never lets the counter go negative. */
async function releaseSeats(rideId, seats) {
  if (!rideId || seats <= 0) return;
  await Ride.updateOne({ _id: rideId, seatsBooked: { $gte: seats } }, { $inc: { seatsBooked: -seats } });
  await Ride.updateOne({ _id: rideId, seatsBooked: { $lt: 0 } }, { $set: { seatsBooked: 0 } });
}

/**
 * Atomically claims `seats` on a ride.
 * The `$expr` guard is the real overbooking protection: two simultaneous
 * requests cannot both see the last seat, because MongoDB applies the filter and
 * the increment to a single document atomically.
 */
async function claimSeats(rideId, seats) {
  return Ride.findOneAndUpdate(
    {
      _id: rideId,
      status: { $in: [RIDE_STATUS.APPROVED, 'available'] },
      $expr: { $gte: [{ $subtract: ['$seats', { $ifNull: ['$seatsBooked', 0] }] }, seats] }
    },
    { $inc: { seatsBooked: seats } },
    { returnDocument: 'after' }
  );
}

/* --------------------------------------------------------- public listings */

router.get('/', optionalAuth, async (req, res) => {
  try {
    const query = {};
    if (req.query.from) query.from = { $regex: String(req.query.from).trim().slice(0, 100), $options: 'i' };
    if (req.query.to) query.to = { $regex: String(req.query.to).trim().slice(0, 100), $options: 'i' };
    if (req.query.vehicleType) query.vehicleType = String(req.query.vehicleType);
    const requestedStatus = String(req.query.status || '').toLowerCase();
    const today = startOfToday();
    if (req.query.date) {
      const date = new Date(req.query.date);
      if (!Number.isNaN(date.getTime())) { const next = new Date(date); next.setDate(next.getDate() + 1); query.date = { $gte: date, $lt: next }; }
    } else if (requestedStatus !== 'all') {
      query.date = { $gte: today };
    }
    // Mirrors GET /vehicles: the public "approved" filter is allowed for anyone,
    // while non-public statuses stay admin-only.
    const publicStatuses = ['approved', 'available', ''];
    if (requestedStatus === 'all') {
      if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access is required to view all ride statuses.' });
      query.status = { $nin: [RIDE_STATUS.REMOVED] };
    } else if (!publicStatuses.includes(requestedStatus) && req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access is required to view other ride statuses.' });
    } else {
      // ONLY admin-approved, verified offers are ever publicly bookable.
      query.status = { $in: [RIDE_STATUS.APPROVED, 'available'] };
      query.verified = true;
    }
    const rides = await Ride.find(query).sort({ date: 1, time: 1 }).limit(200).lean();
    const includePrivate = req.user?.role === 'admin' || req.user?.role === 'owner';
    res.json(await serializeRides(rides, { includePrivate }));
  } catch (error) {
    console.error('[rides] list failed:', error.message);
    res.status(500).json({ message: 'Rides could not be loaded. Please try again.' });
  }
});

/** User's own ride bookings. */
router.get('/bookings/my', requireAuth, async (req, res) => {
  try {
    const docs = await RideBooking.find({ userId: req.user._id })
      .populate('rideId')
      .populate('userId', 'name email phone')
      .sort({ createdAt: -1 })
      .lean();
    res.json(docs.map(serializeBooking));
  } catch (error) {
    console.error('[rides] my bookings failed:', error.message);
    res.status(500).json({ message: 'Ride bookings could not be loaded.' });
  }
});

/** Ride offers published by the signed-in owner (admins may pass all=true). */
router.get('/mine', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const query = req.user.role === 'admin' && req.query.all === 'true' ? {} : { driverId: req.user._id };
    if (req.query.status && req.user.role === 'admin') {
      const status = String(req.query.status).toLowerCase();
      query.status = status === 'all' ? { $nin: [RIDE_STATUS.REMOVED] } : status;
    }
    const rides = await Ride.find(query).sort({ date: 1 }).lean();
    res.json(await serializeRides(rides, { includePrivate: true }));
  } catch (error) {
    console.error('[rides] mine failed:', error.message);
    res.status(500).json({ message: 'Your ride offers could not be loaded.' });
  }
});

/** Seat requests awaiting the owner's decision. */
router.get('/requests', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const rideQuery = req.user.role === 'admin' ? {} : { driverId: req.user._id };
    const rides = await Ride.find(rideQuery).select('_id').lean();
    const rideIds = rides.map(ride => ride._id);
    if (!rideIds.length) return res.json([]);
    const query = { rideId: { $in: rideIds } };
    // `status=all` means "no status filter", NOT a status literally called
    // "all" - which would match nothing and silently show an empty screen.
    const requestedStatus = String(req.query.status || '').toLowerCase();
    if (requestedStatus && requestedStatus !== 'all') query.status = requestedStatus;
    else query.status = { $in: [RIDE_BOOKING_STATUS.PENDING_OWNER, RIDE_BOOKING_STATUS.CONFIRMED, RIDE_BOOKING_STATUS.REJECTED, RIDE_BOOKING_STATUS.COMPLETED] };
    const bookings = await RideBooking.find(query)
      .populate('rideId')
      .populate('userId', 'name email phone')
      .sort({ createdAt: -1 })
      .lean();
    res.json(bookings.map(serializeBooking));
  } catch (error) {
    console.error('[rides] requests failed:', error.message);
    res.status(500).json({ message: 'Ride booking requests could not be loaded.' });
  }
});

/* ------------------------------------------------------- owner ride offers */

router.post('/', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const {
      from, to, date, time, seats, price, vehicle, vehicleType, fuelType,
      numberPlate, driverPhone, vehicleImage, vehicleId, additionalCharges,
      discountPercent, distanceKm, notes, pickupPoint, termsAccepted
    } = req.body || {};

    // A linked registered vehicle supplies the vehicle name, plate, category and
    // photo, so requiring the owner to retype them would be both annoying and the
    // source of the "the image is missing in Find Ride" class of bug.
    let linkedVehicle = null;
    if (vehicleId) {
      if (!mongoose.isValidObjectId(vehicleId)) return res.status(400).json({ message: 'That vehicle reference is not valid.' });
      linkedVehicle = await Vehicle.findById(vehicleId);
      if (!linkedVehicle) return res.status(404).json({ message: 'The selected vehicle no longer exists.' });
      if (req.user.role !== 'admin' && idOf(linkedVehicle.ownerId) !== idOf(req.user._id)) {
        return res.status(403).json({ message: 'You can only offer a ride with a vehicle you own.' });
      }
    }

    const vehicleName = String(vehicle || linkedVehicle?.name || linkedVehicle?.brand || linkedVehicle?.model || '').trim();
    if (!from || !to || !date || !time || !vehicleName || num(seats) < 1 || num(price) < 1) {
      return res.status(400).json({ message: 'From, to, date, time, vehicle, seats and price are required.' });
    }
    // A linked vehicle already knows its own category, so the owner does not have
    // to restate it (and cannot accidentally contradict the registered listing).
    const resolvedType = ['Bike', 'Scooter', 'Car', 'Other'].includes(vehicleType)
      ? vehicleType
      : (['Bike', 'Scooter', 'Car', 'Other'].includes(linkedVehicle?.category) ? linkedVehicle.category
        : ['Bike', 'Scooter', 'Car', 'Other'].includes(linkedVehicle?.type) ? linkedVehicle.type : '');
    if (!resolvedType) {
      return res.status(400).json({ message: 'Vehicle type must be Bike, Scooter, Car or Other.' });
    }
    if (termsAccepted !== true && termsAccepted !== 'true') {
      return res.status(400).json({ message: 'Accept the REVEX ride sharing terms before submitting the offer.' });
    }
    const tripDate = new Date(date);
    if (Number.isNaN(tripDate.getTime())) return res.status(400).json({ message: 'Enter a valid ride date.' });
    const day = new Date(tripDate);
    day.setHours(0, 0, 0, 0);
    if (day < startOfToday()) return res.status(400).json({ message: 'Ride date cannot be in the past.' });
    if (vehicleImage && typeof vehicleImage === 'string' && vehicleImage.length > 4 * 1024 * 1024) {
      return res.status(400).json({ message: 'Vehicle photo must be smaller than 3 MB.' });
    }

    const ride = await Ride.create({
      driverId: req.user._id,
      driver: req.user.name,
      driverPhone: String(driverPhone || req.user.phone || '').trim(),
      from: String(from).trim(),
      to: String(to).trim(),
      date: tripDate,
      time: String(time),
      seats: Math.min(6, num(seats, 1)),
      price: num(price, 0),
      additionalCharges: Math.max(0, num(additionalCharges, 0)),
      discountPercent: Math.min(100, Math.max(0, num(discountPercent, 0))),
      distanceKm: Math.max(0, num(distanceKm, 0)),
      notes: String(notes || '').trim().slice(0, 1000),
      pickupPoint: String(pickupPoint || '').trim().slice(0, 300),
      vehicle: vehicleName,
      vehicleType: resolvedType,
      fuelType: ['Petrol', 'Diesel', 'Electric', 'CNG', 'Hybrid'].includes(fuelType) ? fuelType : (linkedVehicle?.fuelType || 'Petrol'),
      numberPlate: String(numberPlate || linkedVehicle?.numberPlate || '').trim().toUpperCase(),
      vehicleImage: vehicleImageFor(linkedVehicle, vehicleImage),
      vehicleId: linkedVehicle ? linkedVehicle._id : null,
      verified: req.user.role === 'admin',
      status: req.user.role === 'admin' ? RIDE_STATUS.APPROVED : RIDE_STATUS.PENDING,
      submittedAt: new Date()
    });

    const [payload] = await serializeRides(ride, { includePrivate: true });
    res.status(201).json({
      ...payload,
      message: ride.status === RIDE_STATUS.PENDING
        ? 'Ride submitted. It will appear in Find a Ride only after admin approval.'
        : 'Ride published and visible in Find a Ride.'
    });
  } catch (error) {
    console.error('[rides] create failed:', error.message);
    res.status(400).json({ message: error.message || 'Ride could not be published.' });
  }
});

/** Owner edits their own offer while it is still pending. */
router.patch('/:id', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride not found.' });
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: 'Ride not found.' });
    if (req.user.role !== 'admin' && idOf(ride.driverId) !== idOf(req.user._id)) {
      return res.status(403).json({ message: 'You can only edit your own ride offer.' });
    }
    if ([RIDE_STATUS.APPROVED, 'available'].includes(ride.status)) {
      return res.status(409).json({ message: 'This ride is already approved and live. Ask an admin to remove it before changing the route.' });
    }
    const body = req.body || {};
    if (body.from) ride.from = String(body.from).trim();
    if (body.to) ride.to = String(body.to).trim();
    if (body.date) {
      const date = new Date(body.date);
      if (Number.isNaN(date.getTime())) return res.status(400).json({ message: 'Enter a valid ride date.' });
      if (date < startOfToday()) return res.status(400).json({ message: 'Ride date cannot be in the past.' });
      ride.date = date;
    }
    if (body.time) ride.time = String(body.time);
    if (body.seats) ride.seats = Math.min(6, Math.max(1, num(body.seats, ride.seats)));
    if (body.price) ride.price = num(body.price, ride.price);
    if (body.additionalCharges !== undefined) ride.additionalCharges = Math.max(0, num(body.additionalCharges, 0));
    if (body.discountPercent !== undefined) ride.discountPercent = Math.min(100, Math.max(0, num(body.discountPercent, 0)));
    if (body.notes !== undefined) ride.notes = String(body.notes).slice(0, 1000);
    if (body.pickupPoint !== undefined) ride.pickupPoint = String(body.pickupPoint).slice(0, 300);
    if (body.vehicleImage) ride.vehicleImage = imageValue(body.vehicleImage);
    await ride.save();
    const [payload] = await serializeRides(ride, { includePrivate: true });
    res.json({ ...payload, message: 'Ride offer updated.' });
  } catch (error) {
    console.error('[rides] update failed:', error.message);
    res.status(500).json({ message: 'Ride offer could not be updated.' });
  }
});

/** Owner withdraws their own offer. */
router.post('/:id/cancel', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride not found.' });
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: 'Ride not found.' });
    if (req.user.role !== 'admin' && idOf(ride.driverId) !== idOf(req.user._id)) {
      return res.status(403).json({ message: 'You can only cancel your own ride offer.' });
    }
    if ([RIDE_STATUS.REMOVED, RIDE_STATUS.CANCELLED].includes(ride.status)) {
      return res.status(409).json({ message: 'This ride offer is already closed.' });
    }
    const held = await RideBooking.countDocuments({ rideId: ride._id, status: { $in: RIDE_BOOKING_ACTIVE_STATUSES } });
    if (held > 0 && req.user.role !== 'admin') {
      return res.status(409).json({ message: 'Riders have already booked this ride. Ask an admin to remove it so the bookings can be refunded.' });
    }
    ride.status = RIDE_STATUS.CANCELLED;
    ride.removalReason = String(req.body?.reason || 'Cancelled by the owner').slice(0, 1000);
    ride.reviewedAt = new Date();
    await ride.save();
    await RideBooking.updateMany({ rideId: ride._id, status: RIDE_BOOKING_STATUS.PAYMENT_PENDING }, {
      $set: {
        status: RIDE_BOOKING_STATUS.CANCELLED_BY_OWNER,
        cancellation: {
          cancelledBy: CANCELLED_BY.OWNER, cancelledById: ride.driverId, reason: ride.removalReason,
          cancelledAt: new Date(), originalAmount: 0, cancellationFee: 0, refundAmount: 0, finalAmount: 0
        }
      }
    });
    res.json({ success: true, message: 'Ride offer cancelled.', ride: (await serializeRides(ride, { includePrivate: true }))[0] });
  } catch (error) {
    console.error('[rides] cancel failed:', error.message);
    res.status(500).json({ message: 'Ride offer could not be cancelled.' });
  }
});

/** Single ride. Public users only ever see an approved offer. */
router.get('/:id', optionalAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride not found.' });
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: 'This ride is no longer available.' });
    const isPrivileged = req.user?.role === 'admin' || (req.user && idOf(ride.driverId) === idOf(req.user._id));
    if (![RIDE_STATUS.APPROVED, 'available'].includes(ride.status) && !isPrivileged) {
      return res.status(404).json({ message: 'This ride is not available for booking.' });
    }
    const payload = (await serializeRides(ride, { includePrivate: isPrivileged }))[0];
    // A rider who already holds a seat on this ride may see the driver contact.
    if (req.user) {
      const own = await RideBooking.findOne({ rideId: ride._id, userId: req.user._id, status: { $in: [RIDE_BOOKING_STATUS.PENDING_OWNER, RIDE_BOOKING_STATUS.CONFIRMED, RIDE_BOOKING_STATUS.COMPLETED] } }).select('_id').lean();
      if (own) payload.driverPhone = ride.driverPhone;
    }
    res.json(payload);
  } catch (error) {
    console.error('[rides] detail failed:', error.message);
    res.status(500).json({ message: 'Ride details could not be loaded.' });
  }
});

/**
 * Backend-calculated quote for the booking panel. The displayed total, the
 * Razorpay order amount and the stored booking total all come from here.
 */
router.get('/:id/quote', optionalAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride not found.' });
  try {
    const ride = await Ride.findById(req.params.id).lean();
    if (!ride) return res.status(404).json({ message: 'This ride is no longer available.' });
    const seats = Math.max(1, Math.min(6, num(req.query.seats, 1)));
    const booked = await bookedSeatsByRide([ride._id]);
    const seatsAvailable = availableSeats({ totalSeats: ride.seats, bookedSeats: booked.get(idOf(ride._id)) || 0 });
    res.json({
      rideId: idOf(ride._id),
      seats,
      seatsAvailable,
      bookable: [RIDE_STATUS.APPROVED, 'available'].includes(ride.status) && seatsAvailable >= seats,
      ...calculateRideQuote(ride, seats)
    });
  } catch (error) {
    console.error('[rides] quote failed:', error.message);
    res.status(500).json({ message: 'The ride price could not be calculated.' });
  }
});

/* ---------------------------------------------------------- user booking */

/**
 * USER books a seat and pays immediately.
 *
 * The amount is computed here from the stored Ride; nothing the browser sends is
 * trusted. Seats are claimed with a single guarded atomic update, so a ride with
 * 5 seats can never sell 6.
 */
router.post('/:id/book', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that ride. Please try again.' });
  try {
    const requestedSeats = num(req.body?.seats, 1);
    if (!Number.isInteger(requestedSeats) || requestedSeats < 1 || requestedSeats > 6) {
      return res.status(400).json({ message: 'Seat count must be a whole number from 1 to 6.' });
    }
    if (req.body?.termsAccepted !== true && req.body?.termsAccepted !== 'true') {
      return res.status(400).json({ message: 'Accept the REVEX ride sharing terms before booking.' });
    }

    const ride = await Ride.findById(req.params.id);
    if (!ride || ![RIDE_STATUS.APPROVED, 'available'].includes(ride.status) || !ride.verified) {
      return res.status(404).json({ message: 'This ride is not available for booking.' });
    }
    if (new Date(ride.date) < startOfToday()) {
      return res.status(400).json({ message: 'This ride has already departed and cannot be booked.' });
    }
    if (idOf(ride.driverId) === idOf(req.user._id)) {
      return res.status(400).json({ message: 'You cannot book your own ride.' });
    }
    const existing = await RideBooking.findOne({ rideId: ride._id, userId: req.user._id, status: { $in: RIDE_BOOKING_ACTIVE_STATUSES } }).select('_id status').lean();
    if (existing) {
      return res.status(409).json({ message: 'You already have a seat request on this ride.', bookingId: idOf(existing._id) });
    }

    // Atomic seat claim. Fails (null) when the ride closed or seats ran out.
    const claimed = await claimSeats(ride._id, requestedSeats);
    if (!claimed) {
      const booked = await bookedSeatsByRide([ride._id]);
      const left = availableSeats({ totalSeats: ride.seats, bookedSeats: booked.get(idOf(ride._id)) || 0 });
      return res.status(409).json({ message: left > 0 ? `Only ${left} seat(s) are available.` : 'All seats on this ride have been booked.' });
    }

    const quote = calculateRideQuote(claimed, requestedSeats);
    let booking;
    try {
      booking = await RideBooking.create({
        rideId: ride._id,
        userId: req.user._id,
        vehicleId: ride.vehicleId || null,
        vehicleImage: normalizeMediaUrl(ride.vehicleImage, ''),
        seats: requestedSeats,
        totalAmount: quote.grandTotal,
        quote,
        rideSnapshot: snapshotOf(ride),
        paymentMethod: gateway.isConfigured() ? 'razorpay' : 'demo',
        status: RIDE_BOOKING_STATUS.PAYMENT_PENDING,
        paymentStatus: 'pending',
        termsAccepted: true,
        termsAcceptedAt: new Date()
      });
    } catch (error) {
      // Never hold a seat for a booking that does not exist.
      await releaseSeats(ride._id, requestedSeats);
      if (error.code === 11000) return res.status(409).json({ message: 'You already have a seat request on this ride.' });
      throw error;
    }

    await notifyUser(ride.driverId, {
      type: 'booking',
      title: 'New ride booking request',
      message: `${req.user.name} paid ₹${quote.grandTotal} for ${requestedSeats} seat(s) on your ${ride.from} to ${ride.to} ride.`,
      data: { rideBookingId: booking._id.toString(), rideId: ride._id.toString() }
    });

    res.status(201).json({
      ...serializeBooking(booking),
      quote,
      payment: {
        method: gateway.isConfigured() ? 'razorpay' : 'demo',
        currency: 'INR',
        displayAmount: quote.grandTotal,
        amountInPaise: gateway.toPaise(quote.grandTotal),
        keyId: gateway.isConfigured() ? process.env.RAZORPAY_KEY_ID : null,
        nextStep: gateway.isConfigured() ? 'razorpay' : 'test_payment'
      },
      message: 'Seats reserved. Complete the payment to send your request to the driver.'
    });
  } catch (error) {
    console.error('[rides] book failed:', error.message);
    res.status(500).json({ message: 'Ride booking could not be created. Please try again.' });
  }
});

/* ------------------------------------------------------------- payments */

router.post('/bookings/:id/payment-order', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  if (!gateway.isConfigured()) return res.status(503).json({ message: 'Online payment is not configured on this server.' });
  try {
    const booking = await RideBooking.findOne({ _id: req.params.id, userId: req.user._id, status: RIDE_BOOKING_STATUS.PAYMENT_PENDING, paymentStatus: 'pending' });
    if (!booking) return res.status(404).json({ message: 'This ride booking is no longer awaiting payment.' });

    const amount = roundMoney(booking.totalAmount);
    const order = await gateway.createOrder({
      amount,
      receipt: `REVEX-RIDE-${booking._id}`,
      notes: { rideId: idOf(booking.rideId), seats: booking.seats }
    });

    booking.paymentMethod = 'razorpay';
    booking.razorpayOrderId = order.id;
    await booking.save();

    res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    console.error('[rides] payment-order failed:', error.code || '', error.message);
    // Never 401. A Razorpay 401 means the SERVER's keys are wrong, and the
    // browser treats our 401 as an expired session and logs the rider out.
    const rejected = error.code === 'GATEWAY_CREDENTIALS_REJECTED';
    res.status(rejected ? 502 : (Number(error.statusCode) === 400 ? 400 : 502)).json({
      message: error.message || 'Could not create the Razorpay order.',
      code: error.code || 'GATEWAY_ERROR'
    });
  }
});

/**
 * Verifies the checkout callback on the server and only then moves the booking to
 * `pending_owner` (paid, waiting for the driver). A replayed or forged callback
 * cannot create a second paid booking.
 */
router.post('/bookings/:id/verify-payment', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  if (!gateway.isConfigured()) return res.status(503).json({ message: 'Razorpay is not configured on this server.' });
  try {
    const booking = await RideBooking.findOne({ _id: req.params.id, userId: req.user._id });
    if (!booking) return res.status(404).json({ message: 'Ride booking not found.' });
    // Idempotent: Razorpay retries the callback, and a duplicate must not fail.
    if (booking.paymentStatus === 'paid') {
      return res.json({ success: true, message: 'Payment already verified.', booking: serializeBooking(booking) });
    }

    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (!booking.razorpayOrderId || orderId !== booking.razorpayOrderId) {
      return res.status(400).json({ message: 'Payment order does not match this ride booking.' });
    }

    const result = await gateway.verifyCheckout({
      orderId, paymentId, signature,
      expectedAmountPaise: gateway.toPaise(booking.totalAmount)
    });
    if (!result.ok) {
      await RideBooking.findOneAndUpdate(
        { _id: booking._id, userId: req.user._id, paymentStatus: { $ne: 'paid' } },
        { $set: { status: RIDE_BOOKING_STATUS.CANCELLED_BY_USER, paymentStatus: 'failed', cancellation: { cancelledBy: CANCELLED_BY.USER, cancelledById: req.user._id, reason: result.reason, cancelledAt: new Date(), originalAmount: 0, cancellationFee: 0, refundAmount: 0, finalAmount: 0 } } }
      );
      await releaseSeats(booking.rideId, booking.seats);
      return res.status(400).json({ message: `${result.reason} Your seat was released.` });
    }

    const updated = await RideBooking.findOneAndUpdate(
      { _id: booking._id, userId: req.user._id, status: RIDE_BOOKING_STATUS.PAYMENT_PENDING, paymentStatus: 'pending' },
      {
        $set: {
          status: RIDE_BOOKING_STATUS.PENDING_OWNER,
          paymentStatus: 'paid',
          paidAmount: booking.totalAmount,
          paymentMethod: 'razorpay',
          paymentReference: String(paymentId),
          razorpayPaymentId: String(paymentId),
          razorpaySignature: String(signature)
        }
      },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'Ride booking state changed. Please refresh your bookings.' });

    await recordRidePayment(updated, 'razorpay', String(paymentId), { orderId, signature, amount: result.payment?.amount });
    const ride = await Ride.findById(updated.rideId).select('driverId from to').lean();
    if (ride?.driverId) {
      await notifyUser(ride.driverId, {
        type: 'payment',
        title: 'Ride payment received',
        message: `Payment received for the ${ride.from} to ${ride.to} ride. Review the seat request.`,
        data: { rideBookingId: updated._id.toString(), rideId: idOf(updated.rideId) }
      });
    }

    res.json({
      success: true,
      message: 'Payment verified. Your seat request is now with the driver.',
      booking: serializeBooking(updated)
    });
  } catch (error) {
    console.error('[rides] verify-payment failed:', error.message);
    res.status(500).json({ message: 'Payment verification failed. Please try again.' });
  }
});

/**
 * Explicit "test payment" for installations where real payments cannot succeed:
 * either no Razorpay credentials, or credentials Razorpay rejects.
 * It is a real, server-side state change (never a client-side success message),
 * it is only reachable while the gateway is unusable, and it is stored with
 * paymentMethod "demo" so it can never be mistaken for real money.
 */
router.post('/bookings/:id/payment-test', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  // The same probe the client is shown, so a browser with a stale cached config
  // cannot record a demo payment while real payments are working, and a server
  // with rejected keys is not left with no way to pay at all.
  const health = await gateway.checkHealth();
  if (health.usable) return res.status(409).json({ message: 'Online payment is working on this server, so the test payment is disabled. Use the Razorpay checkout.' });
  try {
    const booking = await RideBooking.findOne({ _id: req.params.id, userId: req.user._id, status: RIDE_BOOKING_STATUS.PAYMENT_PENDING, paymentStatus: 'pending' });
    if (!booking) return res.status(404).json({ message: 'This ride booking is no longer awaiting payment.' });
    const reference = `REVEX-RIDE-TEST-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const updated = await RideBooking.findOneAndUpdate(
      { _id: booking._id, userId: req.user._id, status: RIDE_BOOKING_STATUS.PAYMENT_PENDING, paymentStatus: 'pending' },
      { $set: { status: RIDE_BOOKING_STATUS.PENDING_OWNER, paymentStatus: 'paid', paidAmount: booking.totalAmount, paymentMethod: 'demo', paymentReference: reference } },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'This ride booking was already processed.' });
    await recordRidePayment(updated, 'demo', reference, { testMode: true });
    const ride = await Ride.findById(updated.rideId).select('driverId from to').lean();
    if (ride?.driverId) {
      await notifyUser(ride.driverId, { type: 'payment', title: 'Ride payment received', message: `Test payment recorded for the ${ride.from} to ${ride.to} ride.`, data: { rideBookingId: updated._id.toString() } });
    }
    res.json({ success: true, message: 'Test payment recorded. Your seat request is now with the driver.', booking: serializeBooking(updated) });
  } catch (error) {
    console.error('[rides] payment-test failed:', error.message);
    res.status(500).json({ message: 'The test payment could not be recorded.' });
  }
});

/** The rider closed the checkout window: release the held seats. */
router.post('/bookings/:id/payment-failed', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  const booking = await RideBooking.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id, status: RIDE_BOOKING_STATUS.PAYMENT_PENDING, paymentStatus: { $ne: 'paid' } },
    { $set: { status: RIDE_BOOKING_STATUS.CANCELLED_BY_USER, paymentStatus: 'failed', cancellation: { cancelledBy: CANCELLED_BY.USER, cancelledById: req.user._id, reason: 'Payment was not completed.', cancelledAt: new Date(), originalAmount: 0, cancellationFee: 0, refundAmount: 0, finalAmount: 0 } } },
    { returnDocument: 'before' }
  );
  if (!booking) return res.status(404).json({ message: 'Ride booking cannot be released.' });
  await releaseSeats(booking.rideId, booking.seats);
  res.json({ success: true, message: 'Payment was not completed, so the seat was released.' });
});

/* ------------------------------------------- owner decision on a seat request */

router.post('/bookings/:id/decision', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking request not found.' });
  try {
    const decision = String(req.body?.decision || '').toLowerCase();
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ message: 'Choose approve or reject.' });
    if (decision === 'reject' && !reason) return res.status(400).json({ message: 'Enter a reason for rejecting this request.' });

    const booking = await RideBooking.findById(req.params.id).populate('rideId', 'driverId from to');
    if (!booking) return res.status(404).json({ message: 'Ride booking request not found.' });
    const driverId = idOf(booking.rideId?.driverId);
    if (req.user.role !== 'admin' && driverId !== idOf(req.user._id)) {
      return res.status(403).json({ message: 'Only the driver can decide this request.' });
    }
    if (booking.status !== RIDE_BOOKING_STATUS.PENDING_OWNER) {
      return res.status(409).json({ message: 'This ride booking request has already been processed.' });
    }

    if (decision === 'approve') {
      const updated = await RideBooking.findOneAndUpdate(
        { _id: booking._id, status: RIDE_BOOKING_STATUS.PENDING_OWNER },
        {
          $set: {
            status: RIDE_BOOKING_STATUS.CONFIRMED,
            ownerDecision: { decision: 'approved', reason, decidedAt: new Date(), decidedBy: req.user._id }
          }
        },
        { returnDocument: 'after' }
      );
      if (!updated) return res.status(409).json({ message: 'This ride booking request has already been processed.' });
      await notifyUser(updated.userId, {
        type: 'booking',
        title: 'Ride seat confirmed',
        message: `The driver approved your seat on the ${booking.rideId?.from || ''} to ${booking.rideId?.to || ''} ride.`,
        data: { rideBookingId: updated._id.toString() }
      });
      return res.json({ success: true, message: 'Seat request approved.', booking: serializeBooking(updated) });
    }

    // Rejecting a PAID request must refund what the rider paid, less the
    // policy fee for an owner-caused cancellation.
    const paid = booking.paymentStatus === 'paid';
    const policy = paid
      ? computeCancellation({ amount: booking.totalAmount, actor: CANCELLED_BY.OWNER, startsAt: booking.rideId?.date, reason, flow: 'ride', platformFee: booking.quote?.platformFee })
      : computeCancellation({ amount: 0, actor: CANCELLED_BY.OWNER, startsAt: booking.rideId?.date, reason, flow: 'ride' });
    const plan = refundPlan({ amount: booking.totalAmount, fee: policy.cancellationFee, method: booking.paymentMethod });

    let refundResult = { ok: true, refund: { id: '', amount: 0, status: plan.refundable ? 'not_required' : 'no_amount_due', processedAt: new Date() } };
    if (plan.refundable && paid && booking.paymentMethod === 'razorpay') {
      refundResult = await gateway.refund({
        paymentId: booking.razorpayPaymentId || booking.paymentReference,
        amount: plan.refundAmount,
        receipt: `REVEX-RIDE-REJ-${booking._id}`.slice(0, 40),
        notes: { reason: 'Owner rejected the seat request' }
      });
    }

    const updated = await RideBooking.findOneAndUpdate(
      { _id: booking._id, status: RIDE_BOOKING_STATUS.PENDING_OWNER },
      {
        $set: {
          status: RIDE_BOOKING_STATUS.REJECTED,
          ownerDecision: { decision: 'rejected', reason, decidedAt: new Date(), decidedBy: req.user._id },
          cancellation: {
            cancelledBy: CANCELLED_BY.OWNER, cancelledById: req.user._id, reason, cancelledAt: new Date(),
            originalAmount: policy.originalAmount, cancellationFee: policy.cancellationFee,
            cancellationFeePercent: policy.cancellationFeePercent, refundAmount: plan.refundAmount,
            finalAmount: plan.refundAmount, platformFee: policy.platformFee,
            withinFreeWindow: policy.withinFreeWindow, policyVersion: policy.policyVersion, explanation: policy.explanation
          },
          ...(paid
            ? {
                paymentStatus: plan.refundable && plan.channel === 'manual' ? 'paid' : (plan.refundAmount > 0 ? 'refunded' : 'paid'),
                refund: {
                  id: refundResult.refund?.id || '',
                  amount: plan.refundAmount,
                  status: refundResult.ok ? (refundResult.refund?.status || 'requested') : 'failed',
                  processedAt: new Date(),
                  note: refundResult.ok ? plan.note : (refundResult.reason || 'Refund could not be processed automatically.')
                }
              }
            : {})
        }
      },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'This ride booking request has already been processed.' });

    await releaseSeats(booking.rideId?._id || booking.rideId, booking.seats);
    await notifyUser(updated.userId, {
      type: 'booking',
      title: 'Seat request declined',
      message: `The driver declined your seat on this ride.${reason ? ` Reason: ${reason}` : ''} Refund due: ₹${plan.refundAmount}.`,
      data: { rideBookingId: updated._id.toString() }
    });

    res.json({
      success: true,
      message: refundResult.ok
        ? `Seat request rejected. ₹${plan.refundAmount} is refunded to the rider.`
        : `Seat request rejected, but the automatic refund failed and must be processed manually.`,
      booking: serializeBooking(updated),
      refund: { ...plan, gateway: refundResult.refund || null, gatewayError: refundResult.ok ? null : refundResult.reason }
    });
  } catch (error) {
    console.error('[rides] decision failed:', error.message);
    res.status(500).json({ message: 'The ride booking decision could not be saved.' });
  }
});

/* ------------------------------------------------------------ cancellation */

/**
 * USER or OWNER cancellation of a seat booking. Applies the centralised
 * cancellation policy, refunds through Razorpay when money was collected, frees
 * the seat and notifies the other party. The record is never deleted.
 */
router.post('/bookings/:id/cancel', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  try {
    const booking = await RideBooking.findById(req.params.id).populate('rideId', 'driverId from to date time');
    if (!booking) return res.status(404).json({ message: 'Ride booking not found.' });

    const isRider = idOf(booking.userId) === idOf(req.user._id);
    const isDriver = idOf(booking.rideId?.driverId) === idOf(req.user._id);
    const isAdmin = req.user.role === 'admin';
    if (!isRider && !isDriver && !isAdmin) return res.status(403).json({ message: 'You cannot cancel this ride booking.' });

    const cancellable = [RIDE_BOOKING_STATUS.PAYMENT_PENDING, RIDE_BOOKING_STATUS.PENDING_OWNER, RIDE_BOOKING_STATUS.CONFIRMED];
    if (!cancellable.includes(booking.status)) {
      return res.status(409).json({ message: 'This ride booking cannot be cancelled in its current state.' });
    }
    const actor = isAdmin ? CANCELLED_BY.ADMIN : (isDriver ? CANCELLED_BY.OWNER : CANCELLED_BY.USER);
    const reason = String(req.body?.reason || '').trim().slice(0, 500) || (actor === CANCELLED_BY.USER ? 'Cancelled by the rider.' : 'Cancelled by the driver.');

    const paid = booking.paymentStatus === 'paid';
    const policy = computeCancellation({
      amount: paid ? booking.totalAmount : 0,
      actor,
      startsAt: booking.rideId?.date,
      reason,
      flow: 'ride',
      platformFee: booking.quote?.platformFee
    });
    const plan = refundPlan({ amount: paid ? booking.totalAmount : 0, fee: policy.cancellationFee, method: booking.paymentMethod });

    let refundResult = { ok: true, refund: { id: '', amount: 0, status: 'not_required', processedAt: new Date() } };
    if (plan.refundable && paid && booking.paymentMethod === 'razorpay') {
      refundResult = await gateway.refund({
        paymentId: booking.razorpayPaymentId || booking.paymentReference,
        amount: plan.refundAmount,
        receipt: `REVEX-RIDE-CXL-${booking._id}`.slice(0, 40),
        notes: { reason: `Cancelled by ${actor}` }
      });
    }

    const nextStatus = cancelledStatusFor(actor, 'ride');
    const updated = await RideBooking.findOneAndUpdate(
      { _id: booking._id, status: { $in: cancellable } },
      {
        $set: {
          status: nextStatus,
          cancellation: {
            cancelledBy: actor, cancelledById: req.user._id, reason, cancelledAt: new Date(),
            originalAmount: policy.originalAmount, cancellationFee: policy.cancellationFee,
            cancellationFeePercent: policy.cancellationFeePercent, refundAmount: plan.refundAmount,
            finalAmount: plan.refundAmount, platformFee: policy.platformFee,
            withinFreeWindow: policy.withinFreeWindow, policyVersion: policy.policyVersion, explanation: policy.explanation
          },
          ...(paid
            ? {
                paymentStatus: plan.refundable ? 'refunded' : 'paid',
                refund: {
                  id: refundResult.refund?.id || '', amount: plan.refundAmount,
                  status: refundResult.ok ? (refundResult.refund?.status || 'requested') : 'failed',
                  processedAt: new Date(),
                  note: refundResult.ok ? plan.note : (refundResult.reason || 'Refund could not be processed automatically.')
                }
              }
            : {})
        }
      },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'This ride booking was already updated. Please refresh.' });

    await releaseSeats(booking.rideId?._id || booking.rideId, booking.seats);
    await notifyUser(isRider ? booking.rideId?.driverId : booking.userId, {
      type: 'booking',
      title: 'Ride booking cancelled',
      message: `${req.user.name} cancelled a seat on the ${booking.rideId?.from || ''} to ${booking.rideId?.to || ''} ride. ${paid ? `Refund due: ₹${plan.refundAmount}.` : 'No payment was collected.'}`,
      data: { rideBookingId: updated._id.toString() }
    });

    res.json({
      success: true,
      message: refundResult.ok
        ? `Ride booking cancelled. ${plan.refundable ? `₹${plan.refundAmount} is refunded to the rider.` : 'No refund was due.'}`
        : 'Ride booking cancelled, but the automatic refund failed and must be processed manually.',
      booking: serializeBooking(updated),
      cancellation: {
        cancelledBy: actor,
        reason,
        cancelledAt: updated.cancellation?.cancelledAt,
        originalAmount: policy.originalAmount,
        cancellationFee: policy.cancellationFee,
        cancellationFeePercent: policy.cancellationFeePercent,
        refundAmount: plan.refundAmount,
        finalAmount: plan.refundAmount,
        withinFreeWindow: policy.withinFreeWindow,
        explanation: policy.explanation,
        policyVersion: policy.policyVersion
      },
      refund: { ...plan, gateway: refundResult.refund || null, gatewayError: refundResult.ok ? null : refundResult.reason }
    });
  } catch (error) {
    console.error('[rides] cancel failed:', error.message);
    res.status(500).json({ message: 'The ride booking could not be cancelled.' });
  }
});

/**
 * Cancellation preview for a seat booking. The UI calls this BEFORE showing a
 * confirm dialog so the fee and refund the rider sees are the exact numbers the
 * cancel route will apply.
 */
router.get('/bookings/:id/cancellation-preview', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  try {
    const booking = await RideBooking.findById(req.params.id).populate('rideId', 'driverId from to date time');
    if (!booking) return res.status(404).json({ message: 'Ride booking not found.' });
    const isRider = idOf(booking.userId) === idOf(req.user._id);
    const isDriver = idOf(booking.rideId?.driverId) === idOf(req.user._id);
    if (!isRider && !isDriver && req.user.role !== 'admin') return res.status(403).json({ message: 'You cannot view this ride booking.' });
    const actor = req.user.role === 'admin' ? CANCELLED_BY.ADMIN : (isDriver && !isRider ? CANCELLED_BY.OWNER : CANCELLED_BY.USER);
    const paid = booking.paymentStatus === 'paid';
    const policy = computeCancellation({
      amount: paid ? booking.totalAmount : 0, actor, startsAt: booking.rideId?.date, flow: 'ride',
      platformFee: booking.quote?.platformFee
    });
    const plan = refundPlan({ amount: paid ? booking.totalAmount : 0, fee: policy.cancellationFee, method: booking.paymentMethod });
    res.json({
      cancellable: [RIDE_BOOKING_STATUS.PAYMENT_PENDING, RIDE_BOOKING_STATUS.PENDING_OWNER, RIDE_BOOKING_STATUS.CONFIRMED].includes(booking.status),
      status: booking.status,
      statusLabel: RIDE_BOOKING_STATUS_LABELS[booking.status] || booking.status,
      from: booking.rideId?.from || '',
      to: booking.rideId?.to || '',
      startDate: booking.rideId?.date || null,
      seats: booking.seats,
      ...policy,
      refund: plan
    });
  } catch (error) {
    console.error('[rides] cancellation preview failed:', error.message);
    res.status(500).json({ message: 'The cancellation details could not be calculated.' });
  }
});

/** Lets a driver complete a ride they ran. */
router.post('/bookings/:id/complete', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  try {
    const booking = await RideBooking.findById(req.params.id).populate('rideId', 'driverId from to');
    if (!booking) return res.status(404).json({ message: 'Ride booking not found.' });
    if (req.user.role !== 'admin' && idOf(booking.rideId?.driverId) !== idOf(req.user._id)) {
      return res.status(403).json({ message: 'Only the driver can complete this ride.' });
    }
    if (booking.status !== RIDE_BOOKING_STATUS.CONFIRMED) {
      return res.status(409).json({ message: 'Only a confirmed seat can be marked completed.' });
    }
    const updated = await RideBooking.findOneAndUpdate(
      { _id: booking._id, status: RIDE_BOOKING_STATUS.CONFIRMED },
      { $set: { status: RIDE_BOOKING_STATUS.COMPLETED } },
      { returnDocument: 'after' }
    );
    await notifyUser(booking.userId, {
      type: 'booking',
      title: 'Ride completed',
      message: `Your trip ${booking.rideId?.from || ''} to ${booking.rideId?.to || ''} is marked completed. Rate your ride.`,
      data: { rideBookingId: booking._id.toString() }
    });
    res.json({ success: true, message: 'Ride marked completed.', booking: serializeBooking(updated) });
  } catch (error) {
    console.error('[rides] complete failed:', error.message);
    res.status(500).json({ message: 'The ride could not be marked completed.' });
  }
});

router.post('/bookings/:id/feedback', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  const booking = await RideBooking.findById(req.params.id).populate('rideId', 'driverId vehicle vehicleType').populate('userId', '_id name');
  if (!booking) return res.status(404).json({ message: 'Ride booking not found.' });
  const riderId = idOf(booking.userId?._id || booking.userId);
  if (riderId !== idOf(req.user._id) && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'You can only rate your own ride booking.' });
  }
  if (![RIDE_BOOKING_STATUS.CONFIRMED, RIDE_BOOKING_STATUS.COMPLETED].includes(booking.status)) {
    return res.status(400).json({ message: 'Rate a confirmed or completed ride.' });
  }
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: 'Rating must be a whole number from 1 to 5.' });
  booking.rating = rating;
  booking.comment = String(req.body?.comment || '').trim().slice(0, 500);
  await booking.save();
  // Keep the driver's aggregate rating current (the same field the rental
  // listing uses) without creating a second rating system.
  if (booking.rideId?.driverId) {
    const aggregate = await RideBooking.aggregate([
      { $match: { status: { $in: [RIDE_BOOKING_STATUS.CONFIRMED, RIDE_BOOKING_STATUS.COMPLETED] }, rating: { $exists: true } } },
      { $lookup: { from: 'rides', localField: 'rideId', foreignField: '_id', as: 'ride' } },
      { $unwind: '$ride' },
      { $match: { 'ride.driverId': booking.rideId.driverId } },
      { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }
    ]);
    await User.findByIdAndUpdate(booking.rideId.driverId, { rating: Math.round((aggregate[0]?.average || 5) * 10) / 10, ratingCount: aggregate[0]?.count || 0 });
  }
  res.json({ success: true, message: 'Feedback submitted successfully.', booking: serializeBooking(booking) });
});

module.exports = router;

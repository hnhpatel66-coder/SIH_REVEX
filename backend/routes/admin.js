const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Vehicle = require('../models/Vehicle');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Ride = require('../models/Ride');
const RideBooking = require('../models/RideBooking');
const Agreement = require('../models/Agreement');
const Payment = require('../models/Payment');
const MonthlyBookingCounter = require('../models/MonthlyBookingCounter');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../utils/notify');
const { normalizeMediaUrl } = require('../utils/media');
const { applyEarningsDelta, hasEarned, ownerShare, OWNER_SHARE_RATE } = require('../utils/earnings');
const { deleteVehicleCascade, deleteUserCascade, summarise } = require('../utils/hardDelete');
const { computeCancellation, refundPlan, roundMoney } = require('../utils/cancellation');
const { calculateRideQuote, availableSeats } = require('../utils/ridePricing');
const gateway = require('../utils/payments');
const {
  RIDE_STATUS, RIDE_STATUS_LABELS, VEHICLE_STATUS, VEHICLE_STATUS_LABELS,
  BOOKING_STATUS, BOOKING_STATUS_LABELS, RIDE_BOOKING_STATUS, RIDE_BOOKING_STATUS_LABELS,
  RIDE_BOOKING_ACTIVE_STATUSES, BOOKING_CANCELLED_STATUSES, CANCELLED_BY, isCancelled
} = require('../utils/statuses');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

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

function money(value) {
  return roundMoney(num(value, 0));
}

function vehicleStatus(vehicle) {
  if (vehicle.status === 'available') return VEHICLE_STATUS.APPROVED;
  if (vehicle.status === 'unavailable') return VEHICLE_STATUS.REMOVED;
  return vehicle.status || VEHICLE_STATUS.PENDING;
}

function vehicleJson(vehicle) {
  const value = vehicle && typeof vehicle.toObject === 'function' ? vehicle.toObject() : { ...(vehicle || {}) };
  const owner = value.ownerId && typeof value.ownerId === 'object' ? value.ownerId : null;
  const status = vehicleStatus(value);
  const image = normalizeMediaUrl(value.vehiclePicture || value.image || '', '');
  return {
    ...value,
    id: idOf(value._id || value.id),
    ownerId: idOf(value.ownerId),
    owner: owner ? {
      id: idOf(owner), name: owner.name || '', email: owner.email || '',
      phone: owner.phone || '', photo: normalizeMediaUrl(owner.photo, '')
    } : undefined,
    category: value.category || value.type || 'Other',
    type: value.type || value.category || 'Other',
    status,
    statusLabel: VEHICLE_STATUS_LABELS[status] || 'Pending approval',
    image,
    vehiclePicture: image,
    documents: Array.isArray(value.documents) ? value.documents : []
  };
}

function rideJson(ride, { bookedSeats = 0 } = {}) {
  const value = ride && typeof ride.toObject === 'function' ? ride.toObject() : { ...(ride || {}) };
  const driver = value.driverId && typeof value.driverId === 'object' ? value.driverId : null;
  const status = value.status === 'available' ? RIDE_STATUS.APPROVED : (value.status || RIDE_STATUS.PENDING);
  const seats = num(value.seats, 0);
  const seatsAvailable = availableSeats({ totalSeats: seats, bookedSeats });
  return {
    ...value,
    id: idOf(value._id || value.id),
    driverId: idOf(value.driverId),
    driverName: driver?.name || value.driver || '',
    driverPhone: driver?.phone || value.driverPhone || '',
    driverEmail: driver?.email || '',
    vehicleImage: normalizeMediaUrl(value.vehicleImage, ''),
    vehicleId: idOf(value.vehicleId),
    status,
    statusLabel: RIDE_STATUS_LABELS[status] || status,
    seats,
    seatsBooked: bookedSeats,
    seatsAvailable,
    soldOut: seatsAvailable <= 0,
    distanceKm: num(value.distanceKm, 0),
    quote: calculateRideQuote(value, 1)
  };
}

function bookingJson(booking) {
  const value = booking && typeof booking.toObject === 'function' ? booking.toObject() : { ...(booking || {}) };
  const user = value.userId && typeof value.userId === 'object' ? value.userId : null;
  const vehicle = value.vehicleId && typeof value.vehicleId === 'object' ? value.vehicleId : null;
  const status = value.status || BOOKING_STATUS.PAYMENT_PENDING;
  return {
    ...value,
    id: idOf(value._id || value.id),
    userId: user ? { ...user, id: idOf(user) } : idOf(value.userId),
    userName: user?.name || '',
    userEmail: user?.email || '',
    userPhone: user?.phone || '',
    vehicleId: vehicle ? { ...vehicle, id: idOf(vehicle) } : idOf(value.vehicleId),
    vehicleName: vehicle?.name || value.vehicleName || 'Vehicle',
    vehicleImage: normalizeMediaUrl(vehicle?.vehiclePicture || vehicle?.image || value.vehicleImage || '', ''),
    status,
    statusLabel: BOOKING_STATUS_LABELS[status] || status,
    grandTotal: money(value.grandTotal ?? value.totalAmount),
    totalAmount: money(value.totalAmount),
    paidAmount: money(value.paidAmount),
    vehicle: vehicle ? {
      id: idOf(vehicle), name: vehicle.name || '',
      category: vehicle.category || vehicle.type || '',
      numberPlate: vehicle.numberPlate || '',
      image: normalizeMediaUrl(vehicle.vehiclePicture || vehicle.image || '', '')
    } : null,
    cancellation: value.cancellation || null,
    refund: value.refund || null
  };
}

function rideBookingJson(booking) {
  const value = booking && typeof booking.toObject === 'function' ? booking.toObject() : { ...(booking || {}) };
  const ride = value.rideId && typeof value.rideId === 'object' ? value.rideId : null;
  const user = value.userId && typeof value.userId === 'object' ? value.userId : null;
  const snapshot = value.rideSnapshot && typeof value.rideSnapshot === 'object' ? value.rideSnapshot : {};
  const status = value.status || RIDE_BOOKING_STATUS.PAYMENT_PENDING;
  return {
    ...value,
    id: idOf(value._id || value.id),
    rideId: ride ? { ...ride, id: idOf(ride) } : idOf(value.rideId),
    userId: user ? { ...user, id: idOf(user) } : idOf(value.userId),
    userName: user?.name || '',
    userEmail: user?.email || '',
    userPhone: user?.phone || '',
    status,
    statusLabel: RIDE_BOOKING_STATUS_LABELS[status] || status,
    vehicleImage: normalizeMediaUrl(value.vehicleImage || snapshot.vehicleImage || (ride ? ride.vehicleImage : '') || '', ''),
    vehicleName: snapshot.vehicle || ride?.vehicle || '',
    from: snapshot.from || ride?.from || '',
    to: snapshot.to || ride?.to || '',
    rideDate: snapshot.date || ride?.date || null,
    rideTime: snapshot.time || ride?.time || '',
    quote: value.quote && Object.keys(value.quote).length ? value.quote : calculateRideQuote(ride || snapshot, value.seats),
    cancellation: value.cancellation || null,
    refund: value.refund || null
  };
}

async function releaseBookingCounter(booking) {
  if (!booking?.monthlySlot || !booking?.monthKey) return;
  await MonthlyBookingCounter.findOneAndUpdate({ userId: booking.userId, monthKey: booking.monthKey, count: { $gt: 0 } }, { $inc: { count: -1 } });
  await Booking.updateOne({ _id: booking._id }, { $unset: { monthlySlot: 1 } });
}

/** Seats consumed by live bookings, keyed by ride id. */
async function bookedSeatsByRide(rideIds) {
  if (!rideIds.length) return new Map();
  const rows = await RideBooking.aggregate([
    { $match: { rideId: { $in: rideIds }, status: { $in: RIDE_BOOKING_ACTIVE_STATUSES } } },
    { $group: { _id: '$rideId', seats: { $sum: '$seats' } } }
  ]);
  return new Map(rows.map(row => [idOf(row._id), row.seats || 0]));
}

/**
 * Refunds a paid record through Razorpay and returns a description of what
 * happened. A gateway failure is never swallowed: it is stored on the record so
 * an operator can finish it manually.
 */
async function refundRecord({ method, paymentReference, amount, receipt, note }) {
  const plan = refundPlan({ amount, fee: 0, method });
  if (!plan.refundable) return { ok: true, plan, refund: null };
  if (method !== 'razorpay') {
    return { ok: true, plan, refund: { id: '', amount: plan.refundAmount, status: 'manual', processedAt: new Date() } };
  }
  const result = await gateway.refund({ paymentId: paymentReference, amount: plan.refundAmount, receipt, notes: { reason: note || 'REVEX cancellation' } });
  return {
    ok: result.ok,
    plan,
    reason: result.reason || '',
    refund: result.ok ? result.refund : null
  };
}

function ownerSummaryQuery(vehicleIds) {
  return [
    { $match: { vehicleId: { $in: vehicleIds } } },
    { $group: {
      _id: '$vehicleId',
      totalBookings: { $sum: 1 },
      completedBookings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
      pendingBookings: { $sum: { $cond: [{ $in: ['$status', ['payment_pending', 'pending_owner']] }, 1, 0] } },
      activeBookings: { $sum: { $cond: [{ $in: ['$status', ['confirmed', 'pending_owner']] }, 1, 0] } },
      cancelledBookings: { $sum: { $cond: [{ $in: ['$status', BOOKING_CANCELLED_STATUSES] }, 1, 0] } },
      rejectedBookings: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
      grossEarnings: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentStatus', 'paid'] }, { $in: ['$status', ['confirmed', 'completed']] }] }, '$grandTotal', 0] } },
      ownerEarnings: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentStatus', 'paid'] }, { $in: ['$status', ['confirmed', 'completed']] }] }, { $multiply: ['$grandTotal', OWNER_SHARE_RATE] }, 0] } }
    } }
  ];
}

/* ------------------------------------------------------------ dashboard */

router.get('/summary', async (req, res) => {
  try {
    const [users, owners, vehicles, bookings, rides, rideBookings,
      pendingVehicles, approvedVehicles, rejectedVehicles, removedVehicles,
      pendingRides, approvedRides, rentalPaid, ridePaid, completedRental, completedRide, cancelledBookings] = await Promise.all([
      User.countDocuments({ isActive: { $ne: false } }),
      User.countDocuments({ role: 'owner', isActive: { $ne: false } }),
      Vehicle.countDocuments(),
      Booking.countDocuments(),
      Ride.countDocuments(),
      RideBooking.countDocuments(),
      Vehicle.countDocuments({ status: 'pending' }),
      Vehicle.countDocuments({ status: { $in: ['approved', 'available'] } }),
      Vehicle.countDocuments({ status: 'rejected' }),
      Vehicle.countDocuments({ status: { $in: ['removed', 'unavailable'] } }),
      Ride.countDocuments({ status: RIDE_STATUS.PENDING }),
      Ride.countDocuments({ status: { $in: [RIDE_STATUS.APPROVED, 'available'] } }),
      Booking.aggregate([{ $match: { paymentStatus: 'paid', status: { $nin: BOOKING_CANCELLED_STATUSES } } }, { $group: { _id: null, gross: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]),
      RideBooking.aggregate([{ $match: { paymentStatus: 'paid', status: { $nin: ['cancelled', 'cancelled_by_user', 'cancelled_by_owner', 'cancelled_by_admin'] } } }, { $group: { _id: null, gross: { $sum: '$totalAmount' }, count: { $sum: 1 } } }]),
      Booking.aggregate([{ $match: { paymentStatus: 'paid', status: 'completed' } }, { $group: { _id: null, gross: { $sum: '$grandTotal' } } }]),
      RideBooking.aggregate([{ $match: { paymentStatus: 'paid', status: 'completed' } }, { $group: { _id: null, gross: { $sum: '$totalAmount' } } }]),
      Booking.countDocuments({ status: { $in: BOOKING_CANCELLED_STATUSES } })
    ]);

    const rentalGross = money(rentalPaid[0]?.gross);
    const rideGross = money(ridePaid[0]?.gross);
    const gross = money(rentalGross + rideGross);
    const commission = money(gross - gross * OWNER_SHARE_RATE);

    res.json({
      users, owners, vehicles, bookings, rides, rideBookings,
      pendingVehicleVerification: pendingVehicles,
      approvedVehicles, rejectedVehicles, removedVehicles,
      pendingRideApprovals: pendingRides,
      approvedRides,
      rentalBookings: rentalPaid[0]?.count || 0,
      completedRideBookings: ridePaid[0]?.count || 0,
      totalRevenue: gross,
      grossRevenue: gross,
      approvedRevenue: money((completedRental[0]?.gross || 0) + (completedRide[0]?.gross || 0)),
      rentalRevenue: rentalGross,
      rideRevenue: rideGross,
      commission,
      platformEarnings: commission,
      ownerPayout: money(gross - commission),
      ownerShareRate: OWNER_SHARE_RATE,
      cancelledBookings,
      paymentGateway: gateway.publicConfig()
    });
  } catch (error) {
    console.error('[admin] summary failed:', error.message);
    res.status(500).json({ message: 'Admin summary could not be loaded.' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const users = await User.find({}).select('-passwordHash -resetPasswordToken -resetPasswordExpires').sort({ createdAt: -1 }).lean();
    res.json(users.map(user => ({
      ...user,
      id: idOf(user._id),
      active: user.isActive !== false,
      // Resolved to a browser-usable URL once, so the admin Users screen shows
      // the same picture as the profile page.
      photo: normalizeMediaUrl(user.photo, '')
    })));
  } catch (error) {
    console.error('[admin] users failed:', error.message);
    res.status(500).json({ message: 'Users could not be loaded.' });
  }
});

router.post('/create-admin', async (req, res) => {
  try {
    const { name, email, password, confirmPassword, phone } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Full name is required.' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return res.status(400).json({ message: 'Enter a valid email address.' });
    if (!password || String(password).length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    if (confirmPassword !== undefined && password !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match.' });
    const normalizedEmail = String(email).toLowerCase().trim();
    if (await User.exists({ email: normalizedEmail })) return res.status(409).json({ message: 'An account with this email already exists.' });
    const passwordHash = await bcrypt.hash(String(password), 10);
    const admin = await User.create({ name: String(name).trim(), email: normalizedEmail, phone: phone ? String(phone).trim() : '', passwordHash, role: 'admin', isVerified: true });
    res.status(201).json({ message: 'Admin account created successfully.', user: { id: admin._id.toString(), name: admin.name, email: admin.email, phone: admin.phone || '', role: admin.role } });
  } catch (error) {
    console.error('[admin] create-admin failed:', error.message);
    res.status(500).json({ message: 'Could not create admin. Please try again.' });
  }
});

/* -------------------------------------------------------- owner summary */

router.get('/owners', async (req, res) => {
  try {
    const owners = await User.find({ role: 'owner' })
      .select('name email phone createdAt isActive ownerEarnings ownerRideEarnings ownerRentalEarnings rating ratingCount lastLoginAt photo')
      .sort({ createdAt: -1 }).lean();
    const rows = await Promise.all(owners.map(async owner => {
      const vehicles = await Vehicle.find({ ownerId: owner._id }).select('status verified').lean();
      const vehicleIds = vehicles.map(v => v._id);
      const rides = await Ride.find({ driverId: owner._id }).select('status').lean();
      const rideIds = await Ride.distinct('_id', { driverId: owner._id });
      const [bookings, earnings, statusRows, rideBookings, rideEarnings, rideStatusRows] = await Promise.all([
        Booking.countDocuments({ vehicleId: { $in: vehicleIds } }),
        Booking.aggregate([{ $match: { vehicleId: { $in: vehicleIds }, paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } } }, { $group: { _id: null, total: { $sum: { $multiply: ['$grandTotal', OWNER_SHARE_RATE] } } } }]),
        Booking.aggregate([{ $match: { vehicleId: { $in: vehicleIds } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        RideBooking.countDocuments({ rideId: { $in: rideIds } }),
        RideBooking.aggregate([{ $match: { rideId: { $in: rideIds }, paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } } }, { $group: { _id: null, total: { $sum: { $multiply: ['$totalAmount', OWNER_SHARE_RATE] } } } }]),
        Ride.aggregate([{ $match: { driverId: owner._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }])
      ]);
      const statusCounts = Object.fromEntries(statusRows.map(item => [item._id, item.count]));
      const rideStatusCounts = Object.fromEntries(rideStatusRows.map(item => [item._id, item.count]));
      return {
        id: owner._id.toString(),
        name: owner.name,
        email: owner.email,
        phone: owner.phone || '',
        // Resolved once so the Owner Summary list and the owner dashboard show
        // the same profile picture the owner uploaded.
        photo: normalizeMediaUrl(owner.photo, ''),
        active: owner.isActive !== false,
        joinedAt: owner.createdAt,
        lastLoginAt: owner.lastLoginAt || null,
        rating: num(owner.rating, 5),
        ratingCount: num(owner.ratingCount, 0),
        totalVehicles: vehicles.length,
        approvedVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.APPROVED).length,
        pendingVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.PENDING).length,
        rejectedVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.REJECTED).length,
        removedVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.REMOVED).length,
        totalRides: rides.length,
        pendingRides: (rideStatusCounts.pending || 0),
        approvedRides: (rideStatusCounts.approved || 0) + (rideStatusCounts.available || 0),
        totalBookings: bookings,
        pendingBookings: statusCounts.pending_owner || statusCounts.pending || 0,
        approvedBookings: statusCounts.confirmed || 0,
        activeBookings: statusCounts.confirmed || 0,
        completedBookings: statusCounts.completed || 0,
        cancelledBookings: (statusCounts.cancelled || 0) + (statusCounts.cancelled_by_user || 0) + (statusCounts.cancelled_by_owner || 0) + (statusCounts.cancelled_by_admin || 0),
        rejectedBookings: statusCounts.rejected || 0,
        totalRideBookings: rideBookings,
        totalEarnings: money((earnings[0]?.total || 0) + (rideEarnings[0]?.total || 0)),
        rentalEarnings: money(earnings[0]?.total),
        rideEarnings: money(rideEarnings[0]?.total)
      };
    }));
    res.json(rows);
  } catch (error) {
    console.error('[admin] owners failed:', error.message);
    res.status(500).json({ message: 'Owner summary could not be loaded.' });
  }
});

/**
 * OWNER SUMMARY DASHBOARD
 *
 * One endpoint behind the admin's "Owner Summary" screen. It deliberately
 * returns a single document so the screen never has to stitch several
 * half-loaded requests together and show a mixture of real and placeholder
 * numbers.
 *
 * Sections: summary cards, vehicles, rides, rental bookings, ride bookings,
 * revenue split, activity, and verification/documents.
 */
router.get('/owners/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Owner not found.' });
  try {
    const owner = await User.findById(req.params.id)
      .select('name email phone role createdAt isActive ownerEarnings ownerRideEarnings ownerRentalEarnings rating ratingCount lastLoginAt carApprovalStatus totalCarsOnRent photo')
      .lean();
    if (!owner || owner.role !== 'owner') return res.status(404).json({ message: 'Owner not found.' });

    const [vehicles, rides] = await Promise.all([
      Vehicle.find({ ownerId: owner._id }).sort({ createdAt: -1 }).lean(),
      Ride.find({ driverId: owner._id }).sort({ date: 1, createdAt: -1 }).lean()
    ]);
    const vehicleIds = vehicles.map(v => v._id);
    const rideIds = rides.map(r => r._id);
    const rideVehicleIds = rides.map(r => idOf(r.vehicleId)).filter(Boolean);

    const [stats, rentals, rideBookings, bookedMap, documents] = await Promise.all([
      vehicleIds.length ? Booking.aggregate(ownerSummaryQuery(vehicleIds)) : [],
      Booking.find({ $or: [{ ownerId: owner._id }, { vehicleId: { $in: vehicleIds } }] })
        .populate('userId', 'name email phone')
        .populate('vehicleId', 'name category type numberPlate vehiclePicture')
        .sort({ createdAt: -1 }).limit(200).lean(),
      rideIds.length
        ? RideBooking.find({ rideId: { $in: rideIds } })
          .populate('userId', 'name email phone')
          .populate('rideId', 'from to date time vehicle numberPlate price')
          .sort({ createdAt: -1 }).limit(200).lean()
        : [],
      bookedSeatsByRide(rideIds),
      // Documents the owner submitted with their vehicles. They are the same
      // records the vehicle detail screen shows, never a duplicate copy.
      rideVehicleIds.length
        ? Vehicle.find({ _id: { $in: rideVehicleIds } }).select('name numberPlate documents ownershipPaper insurance puc status rejectionReason reviewedAt').lean()
        : []
    ]);
    const statsMap = Object.fromEntries(stats.map(item => [idOf(item._id), item]));

    /* ---------------------------------------------------------------- rides */
    const rideBookingRows = rideBookings.map(rideBookingJson);
    const rideRows = rides.map(ride => {
      const base = rideJson(ride, { bookedSeats: bookedMap.get(idOf(ride._id)) || 0 });
      const mine = rideBookingRows.filter(row => idOf(row.rideId && (row.rideId._id || row.rideId)) === idOf(ride._id));
      const paid = mine.filter(row => row.paymentStatus === 'paid');
      const revenue = paid.reduce((sum, row) => sum + money(row.totalAmount), 0);
      const cancelled = mine.filter(row => isCancelled(row.status));
      const refundTotal = cancelled.reduce((sum, row) => sum + money(row.refund?.amount ?? row.cancellation?.refundAmount), 0);
      return {
        ...base,
        bookings: mine.length,
        paidBookings: paid.length,
        pendingOwner: mine.filter(row => row.status === RIDE_BOOKING_STATUS.PENDING_OWNER).length,
        confirmedBookings: mine.filter(row => row.status === RIDE_BOOKING_STATUS.CONFIRMED).length,
        completedBookings: mine.filter(row => row.status === RIDE_BOOKING_STATUS.COMPLETED).length,
        rejectedBookings: mine.filter(row => row.status === RIDE_BOOKING_STATUS.REJECTED).length,
        cancelledBookings: cancelled.length,
        grossRevenue: money(revenue),
        ownerRevenue: money(ownerShare(revenue)),
        platformRevenue: money(revenue - ownerShare(revenue)),
        refundTotal: money(refundTotal),
        // "Cancellation information" per ride, as required by the owner summary.
        cancellationInfo: {
          cancelled: cancelled.length,
          refundTotal: money(refundTotal),
          lastReason: cancelled[0]?.cancellation?.reason || ride.removalReason || ride.rejectionReason || '',
          lastCancelledAt: cancelled[0]?.cancellation?.cancelledAt || null
        }
      };
    });

    /* --------------------------------------------------------- revenue split */
    const rentalRows = rentals.map(bookingJson);
    const rentalPaidRows = rentalRows.filter(row => row.paymentStatus === 'paid' && ['confirmed', 'completed'].includes(row.status));
    const rentalGross = rentalPaidRows.reduce((sum, row) => sum + money(row.grandTotal), 0);
    const rentalCancelled = rentalRows.filter(row => BOOKING_CANCELLED_STATUSES.includes(row.status));
    const rideGross = rideBookingRows
      .filter(row => row.paymentStatus === 'paid' && ['confirmed', 'completed'].includes(row.status))
      .reduce((sum, row) => sum + money(row.totalAmount), 0);
    const totalGross = money(rentalGross + rideGross);
    const totalRefund = money(
      [...rentalCancelled, ...rideBookingRows.filter(row => isCancelled(row.status))]
        .reduce((sum, row) => sum + money(row.refund?.amount ?? row.cancellation?.refundAmount), 0)
    );

    const revenue = {
      currency: 'INR',
      ownerShareRate: OWNER_SHARE_RATE,
      rental: {
        gross: money(rentalGross),
        ownerShare: money(ownerShare(rentalGross)),
        platformShare: money(rentalGross - ownerShare(rentalGross)),
        bookings: rentalPaidRows.length
      },
      ride: {
        gross: money(rideGross),
        ownerShare: money(ownerShare(rideGross)),
        platformShare: money(rideGross - ownerShare(rideGross)),
        bookings: rideBookingRows.filter(row => row.paymentStatus === 'paid' && ['confirmed', 'completed'].includes(row.status)).length
      },
      total: {
        gross: totalGross,
        ownerShare: money(ownerShare(totalGross)),
        platformShare: money(totalGross - ownerShare(totalGross)),
        refunds: totalRefund,
        net: money(totalGross - totalRefund)
      },
      perVehicle: vehicles.map(vehicle => {
        const item = statsMap[idOf(vehicle._id)] || {};
        return {
          vehicleId: idOf(vehicle._id),
          vehicleName: vehicle.name || 'Vehicle',
          bookings: item.totalBookings || 0,
          gross: money(item.grossEarnings || 0),
          ownerShare: money(ownerShare(item.grossEarnings || 0))
        };
      }).sort((a, b) => b.gross - a.gross),
      perRide: rideRows
        .filter(ride => ride.grossRevenue > 0)
        .map(ride => ({ rideId: ride.id, label: `${ride.from} → ${ride.to}`, gross: ride.grossRevenue, ownerShare: ride.ownerRevenue }))
        .sort((a, b) => b.gross - a.gross)
    };

    /* -------------------------------------------------------------- activity */
    const completedRideCount = rideRows.filter(ride => ride.status === RIDE_STATUS.COMPLETED).length;
    const cancelledRideCount = rideRows.filter(ride => [RIDE_STATUS.CANCELLED, RIDE_STATUS.REMOVED].includes(ride.status)).length;
    const activity = {
      totalVehicles: vehicles.length,
      activeVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.APPROVED).length,
      totalRides: rideRows.length,
      activeRides: rideRows.filter(ride => [RIDE_STATUS.APPROVED, 'available'].includes(ride.status)).length,
      completedRides: completedRideCount,
      cancelledRides: cancelledRideCount,
      totalRideBookings: rideBookingRows.length,
      totalRentalBookings: rentalRows.length,
      completedRentalBookings: rentalRows.filter(row => row.status === 'completed').length,
      totalRevenue: totalGross,
      rideRevenue: money(rideGross),
      rentalRevenue: money(rentalGross),
      cancellationCount: rentalCancelled.length + rideBookingRows.filter(row => isCancelled(row.status)).length,
      userBookingCount: rentalRows.length + rideBookingRows.length
    };

    /* ---------------------------------------------------------- verification */
    const verification = {
      carApprovalStatus: owner.carApprovalStatus || 'pending',
      totalCarsOnRent: num(owner.totalCarsOnRent, 0),
      verifiedVehicles: vehicles.filter(v => v.verified).length,
      pendingVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.PENDING).length,
      rejectedVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.REJECTED).length,
      documents: documents.map(vehicle => ({
        vehicleId: idOf(vehicle._id),
        vehicleName: vehicle.name || 'Vehicle',
        numberPlate: vehicle.numberPlate || '',
        status: vehicleStatus(vehicle),
        rejectionReason: vehicle.rejectionReason || '',
        reviewedAt: vehicle.reviewedAt || null,
        documents: Array.isArray(vehicle.documents) ? vehicle.documents : [],
        legacyDocuments: [
          { type: 'ownership', label: 'Ownership paper', dataUrl: vehicle.ownershipPaper || '' },
          { type: 'insurance', label: 'Insurance', dataUrl: vehicle.insurance || '' },
          { type: 'puc', label: 'PUC', dataUrl: vehicle.puc || '' }
        ].filter(item => item.dataUrl)
      }))
    };

    res.json({
      owner: {
        id: owner._id.toString(),
        name: owner.name,
        email: owner.email,
        phone: owner.phone || '',
        photo: normalizeMediaUrl(owner.photo, ''),
        active: owner.isActive !== false,
        joinedAt: owner.createdAt,
        lastLoginAt: owner.lastLoginAt || null,
        rating: num(owner.rating, 5),
        ratingCount: num(owner.ratingCount, 0)
      },
      totals: {
        totalVehicles: vehicles.length,
        approvedVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.APPROVED).length,
        pendingVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.PENDING).length,
        rejectedVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.REJECTED).length,
        removedVehicles: vehicles.filter(v => vehicleStatus(v) === VEHICLE_STATUS.REMOVED).length,
        totalBookings: stats.reduce((sum, item) => sum + item.totalBookings, 0),
        pendingBookings: stats.reduce((sum, item) => sum + (item.pendingBookings || 0), 0),
        activeBookings: stats.reduce((sum, item) => sum + (item.activeBookings || 0), 0),
        completedBookings: stats.reduce((sum, item) => sum + (item.completedBookings || 0), 0),
        cancelledBookings: stats.reduce((sum, item) => sum + (item.cancelledBookings || 0), 0),
        rejectedBookings: stats.reduce((sum, item) => sum + (item.rejectedBookings || 0), 0),
        totalEarnings: money(stats.reduce((sum, item) => sum + (item.ownerEarnings || 0), 0))
      },
      vehicles: vehicles.map(vehicle => {
        const item = statsMap[idOf(vehicle._id)] || {};
        return {
          ...vehicleJson(vehicle),
          totalBookings: item.totalBookings || 0,
          completedBookings: item.completedBookings || 0,
          activeBookings: item.activeBookings || 0,
          pendingBookings: item.pendingBookings || 0,
          cancelledBookings: item.cancelledBookings || 0,
          rejectedBookings: item.rejectedBookings || 0,
          grossEarnings: money(item.grossEarnings),
          totalEarnings: money(ownerShare(item.grossEarnings || 0))
        };
      }),
      rides: rideRows,
      rideBookings: rideBookingRows,
      rentalBookings: rentalRows,
      recentBookings: rentalRows.slice(0, 25),
      revenue,
      activity,
      verification
    });
  } catch (error) {
    console.error('[admin] owner detail failed:', error.message);
    res.status(500).json({ message: 'Owner details could not be loaded.' });
  }
});

/* ------------------------------------------------------------- agreements */

function serializeAgreement(agreement) {
  const value = agreement && typeof agreement.toObject === 'function' ? agreement.toObject() : { ...(agreement || {}) };
  const booking = value.bookingId && typeof value.bookingId === 'object' ? value.bookingId : null;
  const vehicle = booking?.vehicleId && typeof booking.vehicleId === 'object' ? booking.vehicleId : null;
  const renter = booking?.userId && typeof booking.userId === 'object' ? booking.userId : null;
  const owner = vehicle?.ownerId && typeof vehicle.ownerId === 'object' ? vehicle.ownerId : null;
  return {
    ...value,
    id: idOf(value._id || value.id),
    bookingId: idOf(value.bookingId),
    booking: booking ? {
      id: idOf(booking._id),
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      startDate: booking.startDate,
      endDate: booking.endDate,
      totalAmount: booking.totalAmount,
      grandTotal: booking.grandTotal,
      paidAmount: booking.paidAmount || 0,
      remainingAmount: booking.remainingAmount ?? Math.max(0, (booking.grandTotal ?? booking.totalAmount ?? 0) - (booking.paidAmount || 0)),
      createdAt: booking.createdAt
    } : null,
    renter: renter ? { id: idOf(renter), name: renter.name || '', email: renter.email || '', phone: renter.phone || '' } : { name: value.renterName || '', email: value.renterEmail || '', phone: value.renterPhone || '' },
    owner: owner ? { id: idOf(owner), name: owner.name || '', email: owner.email || '', phone: owner.phone || '' } : { name: value.ownerName || '', email: value.ownerEmail || '', phone: value.ownerPhone || '' },
    vehicle: vehicle ? { id: idOf(vehicle), name: vehicle.name || '', category: vehicle.category || vehicle.type || '', fuelType: vehicle.fuelType || '', numberPlate: vehicle.numberPlate || '' } : { name: value.vehicleName || '', category: value.vehicleCategory || value.vehicleType || '', fuelType: value.vehicleFuelType || '', numberPlate: value.vehicleNumberPlate || '' },
    agreementStatus: value.agreementStatus || 'pending_user',
    acceptedByUser: Boolean(value.acceptedByUser),
    acceptedByOwner: Boolean(value.acceptedByOwner),
    paymentStatus: value.paymentStatus || 'PENDING',
    hasDocument: Boolean(value.termsSnapshot?.length || value.pricingSnapshot)
  };
}

router.get('/agreements', async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.agreementStatus = req.query.status;
    if (req.query.search) {
      const search = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ agreementId: new RegExp(search, 'i') }, { renterName: new RegExp(search, 'i') }, { ownerName: new RegExp(search, 'i') }, { vehicleName: new RegExp(search, 'i') }];
    }
    const [agreements, total, allBookingIds] = await Promise.all([
      Agreement.find(filter)
        .populate({ path: 'bookingId', populate: [{ path: 'userId', select: 'name email phone' }, { path: 'vehicleId', select: 'name category type numberPlate fuelType ownerId', populate: { path: 'ownerId', select: 'name email phone' } }] })
        .sort({ createdAt: -1 }).limit(500).lean(),
      Agreement.countDocuments(filter),
      Agreement.distinct('bookingId')
    ]);
    const missingBookings = await Booking.find({ _id: { $nin: allBookingIds } }).select('status paymentStatus startDate endDate totalAmount grandTotal createdAt').sort({ createdAt: -1 }).limit(100).lean();
    res.json({ agreements: agreements.map(serializeAgreement), total, missingBookings: missingBookings.map(booking => ({ id: idOf(booking._id), status: booking.status, paymentStatus: booking.paymentStatus, startDate: booking.startDate, endDate: booking.endDate, totalAmount: booking.totalAmount, grandTotal: booking.grandTotal, createdAt: booking.createdAt })) });
  } catch (error) {
    console.error('[admin] agreements failed:', error.message);
    res.status(500).json({ message: 'Agreements could not be loaded.' });
  }
});

router.get('/agreements/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Agreement not found.' });
  try {
    const agreement = await Agreement.findById(req.params.id)
      .populate({ path: 'bookingId', populate: [{ path: 'userId', select: 'name email phone' }, { path: 'vehicleId', select: 'name category type numberPlate fuelType ownerId', populate: { path: 'ownerId', select: 'name email phone' } }] })
      .lean();
    if (!agreement) return res.status(404).json({ message: 'Agreement not found.' });
    res.json(serializeAgreement(agreement));
  } catch (error) {
    console.error('[admin] agreement failed:', error.message);
    res.status(500).json({ message: 'Agreement could not be loaded.' });
  }
});

/* --------------------------------------------------------------- vehicles */

router.get('/vehicles', async (req, res) => {
  try {
    const status = String(req.query.status || 'all').toLowerCase();
    const query = status === 'all' ? {} : { status };
    const vehicles = await Vehicle.find(query).populate('ownerId', 'name email phone photo').sort({ createdAt: -1 }).lean();
    res.json(vehicles.map(vehicleJson));
  } catch (error) {
    console.error('[admin] vehicles failed:', error.message);
    res.status(500).json({ message: 'Vehicle inventory could not be loaded.' });
  }
});

/**
 * Vehicle drill-down: view, documents, bookings, ride offers, revenue.
 * The admin can reach every per-vehicle action from one screen.
 */
router.get('/vehicles/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Vehicle not found.' });
  try {
    const vehicle = await Vehicle.findById(req.params.id).populate('ownerId', 'name email phone photo').lean();
    if (!vehicle) return res.status(404).json({ message: 'We could not find that vehicle. Please try again.' });
    const [bookings, rides, stats] = await Promise.all([
      Booking.find({ vehicleId: vehicle._id }).populate('userId', 'name email phone').sort({ createdAt: -1 }).limit(100).lean(),
      Ride.find({ vehicleId: vehicle._id }).sort({ date: 1 }).lean(),
      Booking.aggregate(ownerSummaryQuery([vehicle._id]))
    ]);
    const item = stats[0] || {};
    res.json({
      vehicle: vehicleJson(vehicle),
      stats: {
        totalBookings: item.totalBookings || 0,
        completedBookings: item.completedBookings || 0,
        activeBookings: item.activeBookings || 0,
        pendingBookings: item.pendingBookings || 0,
        cancelledBookings: item.cancelledBookings || 0,
        rejectedBookings: item.rejectedBookings || 0,
        grossEarnings: money(item.grossEarnings),
        ownerEarnings: money(ownerShare(item.grossEarnings || 0))
      },
      documents: Array.isArray(vehicle.documents) ? vehicle.documents : [],
      bookings: bookings.map(bookingJson),
      rides: rides.map(ride => rideJson(ride))
    });
  } catch (error) {
    console.error('[admin] vehicle detail failed:', error.message);
    res.status(500).json({ message: 'Vehicle details could not be loaded.' });
  }
});

router.patch('/vehicles/:id/verify', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Vehicle not found.' });
  try {
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) return res.status(404).json({ message: 'We could not find that vehicle. Please try again.' });
    const decision = String(req.body.decision || (req.body.verified === true || req.body.verified === 'true' ? 'approve' : 'reject')).toLowerCase();
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ message: 'Choose approve or reject.' });
    const reason = String(req.body.reason || '').trim().slice(0, 1000);
    if (decision === 'reject' && !reason) return res.status(400).json({ message: 'Enter a rejection reason so the owner knows what to fix.' });
    vehicle.status = decision === 'approve' ? VEHICLE_STATUS.APPROVED : VEHICLE_STATUS.REJECTED;
    vehicle.verified = decision === 'approve';
    vehicle.availability = decision === 'approve' ? 'available' : 'unavailable';
    vehicle.reviewedAt = new Date();
    vehicle.reviewedBy = req.user._id;
    vehicle.rejectionReason = decision === 'reject' ? reason : '';
    vehicle.removalReason = '';
    await vehicle.save();
    await notifyUser(vehicle.ownerId, {
      type: 'vehicle',
      title: decision === 'approve' ? 'Vehicle approved' : 'Vehicle needs attention',
      message: decision === 'approve' ? `${vehicle.name} is approved and can now be booked.` : `${vehicle.name} was rejected: ${reason}`,
      data: { vehicleId: vehicle._id.toString(), status: vehicle.status }
    });
    res.json({ message: decision === 'approve' ? 'Vehicle approved.' : 'Vehicle rejected and moved to Rejected.', vehicle: vehicleJson(vehicle) });
  } catch (error) {
    console.error('[admin] vehicle verify failed:', error.message);
    res.status(500).json({ message: 'Vehicle moderation failed. Please try again.' });
  }
});

/**
 * Removes a vehicle from the marketplace WITHOUT deleting it.
 * `mode: "disable"` is the safe default and is what the Owner Summary screen
 * uses; `mode: "delete"` keeps the previous, explicitly confirmed hard delete
 * available from the vehicle inventory screen.
 */
router.patch('/vehicles/:id/status', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Vehicle not found.' });
  try {
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) return res.status(404).json({ message: 'We could not find that vehicle. Please try again.' });
    const status = String(req.body.status || '').toLowerCase();
    if (![VEHICLE_STATUS.APPROVED, VEHICLE_STATUS.REJECTED, VEHICLE_STATUS.REMOVED, VEHICLE_STATUS.PENDING].includes(status)) {
      return res.status(400).json({ message: 'Status must be approved, rejected, removed or pending.' });
    }
    const reason = String(req.body.reason || '').trim().slice(0, 1000);
    if ([VEHICLE_STATUS.REJECTED, VEHICLE_STATUS.REMOVED].includes(status) && !reason) {
      return res.status(400).json({ message: 'Enter a reason so the owner knows what happened.' });
    }
    vehicle.status = status;
    vehicle.verified = status === VEHICLE_STATUS.APPROVED;
    vehicle.availability = status === VEHICLE_STATUS.APPROVED ? 'available' : 'unavailable';
    vehicle.removalReason = status === VEHICLE_STATUS.REMOVED ? reason : '';
    vehicle.rejectionReason = status === VEHICLE_STATUS.REJECTED ? reason : '';
    if (status === VEHICLE_STATUS.REMOVED) vehicle.removedAt = new Date();
    if (status === VEHICLE_STATUS.APPROVED) { vehicle.removedAt = null; vehicle.rejectionReason = ''; }
    vehicle.reviewedAt = new Date();
    vehicle.reviewedBy = req.user._id;
    await vehicle.save();
    await notifyUser(vehicle.ownerId, {
      type: 'vehicle',
      title: status === VEHICLE_STATUS.REMOVED ? 'Vehicle removed' : `Vehicle ${status}`,
      message: `${vehicle.name} is now "${VEHICLE_STATUS_LABELS[status] || status}" by an administrator${reason ? `: ${reason}` : '.'}`,
      data: { vehicleId: vehicle._id.toString(), status: vehicle.status }
    });
    res.json({ message: `${vehicle.name} is now "${VEHICLE_STATUS_LABELS[status] || status}".`, vehicle: vehicleJson(vehicle) });
  } catch (error) {
    console.error('[admin] vehicle status failed:', error.message);
    res.status(500).json({ message: 'The vehicle could not be updated.' });
  }
});

router.delete('/vehicles/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Vehicle not found.' });
  try {
    const vehicle = await Vehicle.findById(req.params.id).select('name ownerId').lean();
    if (!vehicle) return res.status(404).json({ message: 'We could not find that vehicle. Please try again.' });

    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    if (!reason) return res.status(400).json({ message: 'Enter a reason before deleting this vehicle.' });
    const confirmed = req.body?.confirm === true || req.body?.confirm === 'true';
    if (!confirmed) return res.status(400).json({ message: 'Deletion must be confirmed.', code: 'CONFIRMATION_REQUIRED' });

    const dependents = await Booking.countDocuments({ vehicleId: vehicle._id });
    // Notify BEFORE the cascade, so the row is not swept away by the same
    // query that removes vehicle-scoped notifications.
    await notifyUser(vehicle.ownerId, {
      type: 'vehicle',
      title: 'Vehicle deleted',
      message: `${vehicle.name} was permanently deleted by an administrator: ${reason}`,
      data: { vehicleId: String(vehicle._id) }
    });

    const result = await deleteVehicleCascade(vehicle._id);
    if (!result.deleted) return res.status(404).json({ message: 'Vehicle not found.' });

    res.json({
      success: true,
      message: `${vehicle.name} was deleted permanently. ${summarise(result)}`,
      reason,
      dependents,
      counts: result.counts,
      deletedId: idOf(vehicle._id)
    });
  } catch (error) {
    console.error('[admin] vehicle delete failed:', error.message);
    res.status(500).json({ message: 'Vehicle could not be deleted.' });
  }
});

/* ----------------------------------------------------------------- income */

router.get('/income', async (req, res) => {
  try {
    const paidMatch = { paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } };
    const [rentalPaid, rentalPending, ridePaid, completedRental, completedRide, completedCount, pendingCount, cancelledCount, byVehicle] = await Promise.all([
      Booking.aggregate([{ $match: paidMatch }, { $group: { _id: null, gross: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]),
      Booking.aggregate([{ $match: { paymentStatus: 'pending', status: 'payment_pending' } }, { $group: { _id: null, gross: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]),
      RideBooking.aggregate([{ $match: paidMatch }, { $group: { _id: null, gross: { $sum: '$totalAmount' }, count: { $sum: 1 } } }]),
      Booking.aggregate([{ $match: { paymentStatus: 'paid', status: 'completed' } }, { $group: { _id: null, gross: { $sum: '$grandTotal' } } }]),
      RideBooking.aggregate([{ $match: { paymentStatus: 'paid', status: 'completed' } }, { $group: { _id: null, gross: { $sum: '$totalAmount' } } }]),
      Booking.countDocuments({ paymentStatus: 'paid', status: 'completed' }),
      Booking.countDocuments({ status: { $in: ['payment_pending', 'pending_owner'] } }),
      Booking.countDocuments({ status: { $in: BOOKING_CANCELLED_STATUSES } }),
      Booking.aggregate([{ $match: paidMatch }, { $group: { _id: '$vehicleId', bookings: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } }, { $sort: { revenue: -1 } }])
    ]);
    const vehicleIds = byVehicle.map(row => row._id);
    const vehicles = await Vehicle.find({ _id: { $in: vehicleIds } }).select('name type category ownerId').lean();
    const vehicleMap = Object.fromEntries(vehicles.map(v => [idOf(v._id), v]));
    const ownerIds = [...new Set(vehicles.map(v => idOf(v.ownerId)).filter(Boolean))];
    const owners = await User.find({ _id: { $in: ownerIds } }).select('name').lean();
    const ownerMap = Object.fromEntries(owners.map(owner => [idOf(owner._id), owner.name]));
    const byOwner = {};
    for (const row of byVehicle) {
      const vehicle = vehicleMap[idOf(row._id)];
      const key = idOf(vehicle?.ownerId) || 'unknown';
      byOwner[key] ||= { ownerId: key, ownerName: ownerMap[key] || 'Owner', bookings: 0, revenue: 0 };
      byOwner[key].bookings += row.bookings;
      byOwner[key].revenue += row.revenue;
    }
    const rentalGross = money(rentalPaid[0]?.gross);
    const rideGross = money(ridePaid[0]?.gross);
    const gross = money(rentalGross + rideGross);
    const commission = money(gross - gross * OWNER_SHARE_RATE);
    const recent = await Booking.find(paidMatch).populate('userId', 'name').populate('vehicleId', 'name').sort({ createdAt: -1 }).limit(10).lean();

    // Revenue per individual rental booking, as required by the reports screen.
    const perBooking = await Booking.find(paidMatch)
      .select('grandTotal totalAmount status createdAt startDate endDate')
      .populate('userId', 'name')
      .populate('vehicleId', 'name')
      .sort({ createdAt: -1 }).limit(50).lean();

    res.json({
      totalRevenue: gross,
      rentalRevenue: rentalGross,
      rideRevenue: rideGross,
      completedRevenue: money((completedRental[0]?.gross || 0) + (completedRide[0]?.gross || 0)),
      pendingRevenue: money(rentalPending[0]?.gross),
      commission,
      platformEarnings: commission,
      ownerPayout: money(gross - commission),
      ownerShareRate: OWNER_SHARE_RATE,
      completedBookings: completedCount,
      pendingBookings: pendingCount,
      cancelledBookings: cancelledCount,
      rentalBookings: rentalPaid[0]?.count || 0,
      rideBookings: ridePaid[0]?.count || 0,
      revenueByVehicle: byVehicle.map(row => {
        const vehicle = vehicleMap[idOf(row._id)];
        return {
          vehicleId: idOf(row._id), vehicleName: vehicle?.name || 'Vehicle',
          vehicleType: vehicle?.category || vehicle?.type || '', ownerName: ownerMap[idOf(vehicle?.ownerId)] || '',
          bookings: row.bookings, revenue: money(row.revenue), ownerShare: money(ownerShare(row.revenue))
        };
      }),
      revenueByOwner: Object.values(byOwner).map(item => ({ ...item, revenue: money(item.revenue), ownerShare: money(ownerShare(item.revenue)) })).sort((a, b) => b.revenue - a.revenue),
      revenueByBooking: perBooking.map(booking => ({
        bookingId: idOf(booking._id),
        vehicleName: booking.vehicleId?.name || 'Vehicle',
        renter: booking.userId?.name || 'Renter',
        status: booking.status,
        startDate: booking.startDate,
        endDate: booking.endDate,
        amount: money(booking.grandTotal ?? booking.totalAmount),
        ownerShare: money(ownerShare(booking.grandTotal ?? booking.totalAmount)),
        platformShare: money((booking.grandTotal ?? booking.totalAmount) - ownerShare(booking.grandTotal ?? booking.totalAmount)),
        date: booking.createdAt
      })),
      recent: recent.map(booking => ({ id: idOf(booking._id), vehicle: booking.vehicleId?.name || 'Vehicle', renter: booking.userId?.name || 'Renter', amount: money(booking.grandTotal ?? booking.totalAmount), status: booking.status, date: booking.createdAt }))
    });
  } catch (error) {
    console.error('[admin] income failed:', error.message);
    res.status(500).json({ message: 'Income data could not be loaded.' });
  }
});

router.get('/payments', async (req, res) => {
  try {
    const query = {};
    if (req.query.kind) query.kind = String(req.query.kind);
    if (req.query.status) query.status = String(req.query.status);
    const payments = await Payment.find(query)
      .populate('userId', 'name email')
      .populate('ownerId', 'name')
      .sort({ createdAt: -1 }).limit(200).lean();
    res.json(payments.map(payment => ({
      id: idOf(payment._id),
      kind: payment.kind,
      amount: money(payment.amount),
      refundAmount: money(payment.refundAmount),
      currency: payment.currency,
      method: payment.method,
      status: payment.status,
      reference: payment.reference,
      user: payment.userId ? { id: idOf(payment.userId), name: payment.userId.name, email: payment.userId.email } : null,
      owner: payment.ownerId ? { id: idOf(payment.ownerId), name: payment.ownerId.name } : null,
      createdAt: payment.createdAt,
      paidAt: payment.paidAt,
      refundedAt: payment.refundedAt
    })));
  } catch (error) {
    console.error('[admin] payments failed:', error.message);
    res.status(500).json({ message: 'Payments could not be loaded.' });
  }
});

/* --------------------------------------------------------------- bookings */

router.get('/bookings', async (req, res) => {
  try {
    const docs = await Booking.find({})
      .populate('userId', 'name email phone')
      .populate('vehicleId', 'name type category location numberPlate fuelType vehiclePicture image')
      .sort({ createdAt: -1 }).lean();
    res.json(docs.map(bookingJson));
  } catch (error) {
    console.error('[admin] bookings failed:', error.message);
    res.status(500).json({ message: 'Bookings could not be loaded.' });
  }
});

/**
 * Admin booking moderation.
 *
 * Cancelling a PAID booking is allowed and always runs the centralised
 * cancellation policy plus a real refund attempt. The record is never deleted:
 * the status, the reason and the refund outcome become the audit trail.
 */
router.patch('/bookings/:id/status', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  const requested = String(req.body.status || '').toLowerCase();
  const allowed = ['cancelled', 'completed', 'confirmed', 'pending_owner'];
  if (!allowed.includes(requested)) return res.status(400).json({ message: 'Admin can set a booking to cancelled, completed, confirmed or awaiting owner approval.' });
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    if (requested === 'confirmed' && (booking.paymentStatus !== 'paid' || booking.status !== 'pending_owner')) return res.status(400).json({ message: 'Only a paid request awaiting owner approval can be confirmed.' });
    if (requested === 'completed' && (booking.paymentStatus !== 'paid' || !['confirmed', 'completed'].includes(booking.status))) return res.status(400).json({ message: 'Only a confirmed paid booking can be marked completed.' });
    if (BOOKING_CANCELLED_STATUSES.includes(booking.status)) return res.status(409).json({ message: 'This booking is already cancelled.' });

    const previous = booking.status;
    const reason = String(req.body.reason || '').trim().slice(0, 500);

    if (requested === 'cancelled') {
      const paid = booking.paymentStatus === 'paid';
      const policy = computeCancellation({
        amount: paid ? booking.grandTotal ?? booking.totalAmount : 0,
        actor: CANCELLED_BY.ADMIN,
        startsAt: booking.startDate,
        reason: reason || 'Cancelled by an administrator.',
        flow: 'rental',
        platformFee: booking.pricingSnapshot?.platformFee ?? booking.discountedSubtotal * 0.1
      });
      const plan = refundPlan({ amount: paid ? booking.grandTotal ?? booking.totalAmount : 0, fee: policy.cancellationFee, method: booking.paymentMethod });
      const result = plan.refundable && paid
        ? await refundRecord({
          method: booking.paymentMethod,
          paymentReference: booking.razorpayPaymentId || booking.paymentReference,
          amount: plan.refundAmount,
          receipt: `REVEX-BOOK-CXL-${booking._id}`.slice(0, 40),
          note: 'Admin cancellation'
        })
        : { ok: true, plan, refund: null };

      booking.status = BOOKING_STATUS.CANCELLED_BY_ADMIN;
      booking.cancellation = {
        cancelledBy: CANCELLED_BY.ADMIN, cancelledById: req.user._id,
        reason: reason || 'Cancelled by an administrator.', cancelledAt: new Date(),
        originalAmount: policy.originalAmount, cancellationFee: policy.cancellationFee,
        cancellationFeePercent: policy.cancellationFeePercent, refundAmount: plan.refundAmount,
        finalAmount: plan.refundAmount, platformFee: policy.platformFee,
        withinFreeWindow: policy.withinFreeWindow, policyVersion: policy.policyVersion, explanation: policy.explanation
      };
      if (paid) {
        booking.paymentStatus = plan.refundable ? 'refunded' : 'paid';
        booking.refund = {
          id: result.refund?.id || '', amount: plan.refundAmount,
          status: result.ok ? (result.refund?.status || (result.refund ? 'manual' : 'not_required')) : 'failed',
          processedAt: new Date(),
          note: result.ok ? plan.note : (result.reason || 'Refund could not be processed automatically.')
        };
      }
      // Reverse any earnings already credited for a confirmed booking.
      if (hasEarned(previous) && paid) await applyEarningsDelta(booking, -1);
      await releaseBookingCounter(booking);
      await booking.save();
      await notifyUser(booking.userId, {
        type: 'booking',
        title: 'Booking cancelled by admin',
        message: `Your booking was cancelled by an administrator.${reason ? ` Reason: ${reason}` : ''} ${plan.refundable ? `₹${plan.refundAmount} is refunded.` : 'No refund was due.'}`,
        data: { bookingId: booking._id.toString() }
      });
      const payload = await Booking.findById(booking._id).populate('userId', 'name email phone').populate('vehicleId', 'name type category location numberPlate fuelType vehiclePicture image').lean();
      return res.json({
        message: result.ok
          ? `Booking cancelled. ${plan.refundable ? `₹${plan.refundAmount} refunded.` : 'No refund was due.'}`
          : 'Booking cancelled, but the automatic refund failed and must be processed manually.',
        booking: bookingJson(payload),
        cancellation: booking.cancellation,
        refund: { ...plan, gateway: result.refund || null, gatewayError: result.ok ? null : (result.reason || '') }
      });
    }

    booking.status = requested;
    await booking.save();
    if (requested === 'confirmed') {
      const agreement = await Agreement.findOne({ bookingId: booking._id });
      if (agreement) { agreement.acceptedByOwner = true; agreement.ownerAcceptedAt = new Date(); agreement.agreementStatus = 'approved'; await agreement.save(); }
      await applyEarningsDelta(booking, 1);
    }
    await notifyUser(booking.userId, { type: 'booking', title: 'Booking status updated', message: `Your booking is now ${BOOKING_STATUS_LABELS[requested] || requested}.`, data: { bookingId: booking._id.toString() } });
    return res.json({ message: 'Booking status updated.', booking: bookingJson(booking) });
  } catch (error) {
    console.error('[admin] booking status failed:', error.message);
    res.status(500).json({ message: 'The booking status could not be updated.' });
  }
});

/* ---------------------------------------------------------- ride approvals */

/**
 * ADMIN RIDE APPROVAL QUEUE
 *
 * Returns everything the approval screen must display, including the vehicle
 * photo and the registered vehicle details, so the admin never has to open a
 * second screen to make a decision.
 */
router.get('/ride-approvals', async (req, res) => {
  try {
    const status = String(req.query.status || RIDE_STATUS.PENDING).toLowerCase();
    const query = status === 'all' ? { status: { $ne: RIDE_STATUS.REMOVED } } : { status };
    const rides = await Ride.find(query)
      .populate('driverId', 'name email phone isVerified rating ratingCount')
      .populate('vehicleId', 'name brand model category type numberPlate fuelType vehiclePicture image documents status')
      .sort({ submittedAt: 1, createdAt: 1 }).lean();
    const booked = await bookedSeatsByRide(rides.map(ride => ride._id));
    res.json(rides.map(ride => {
      const driver = ride.driverId && typeof ride.driverId === 'object' ? ride.driverId : null;
      const vehicle = ride.vehicleId && typeof ride.vehicleId === 'object' ? ride.vehicleId : null;
      const base = rideJson(ride, { bookedSeats: booked.get(idOf(ride._id)) || 0 });
      return {
        ...base,
        driverId: driver ? idOf(driver) : idOf(ride.driverId),
        driverName: driver?.name || ride.driver || '',
        driverEmail: driver?.email || '',
        driverPhone: driver?.phone || ride.driverPhone || '',
        driverVerified: driver?.isVerified ?? null,
        driverRating: num(driver?.rating, 5),
        driverRatingCount: num(driver?.ratingCount, 0),
        vehicleDetails: vehicle ? {
          id: idOf(vehicle),
          name: vehicle.name || '',
          brand: vehicle.brand || '',
          model: vehicle.model || '',
          category: vehicle.category || vehicle.type || '',
          fuelType: vehicle.fuelType || '',
          numberPlate: vehicle.numberPlate || '',
          image: normalizeMediaUrl(vehicle.vehiclePicture || vehicle.image || '', ''),
          status: vehicleStatus(vehicle),
          documents: Array.isArray(vehicle.documents) ? vehicle.documents : []
        } : null,
        submittedAt: ride.submittedAt || ride.createdAt
      };
    }));
  } catch (error) {
    console.error('[admin] ride approvals failed:', error.message);
    res.status(500).json({ message: 'Ride approval requests could not be loaded.' });
  }
});

router.get('/ride-bookings', async (req, res) => {
  try {
    const query = {};
    // `status=all` means "no status filter", not a status literally called
    // "all" - which would match nothing and silently show an empty screen.
    const requestedStatus = String(req.query.status || '').toLowerCase();
    if (requestedStatus && requestedStatus !== 'all') query.status = requestedStatus;
    const docs = await RideBooking.find(query)
      .populate('userId', 'name email phone')
      .populate('rideId', 'from to date time vehicle numberPlate price driver')
      .sort({ createdAt: -1 }).lean();
    res.json(docs.map(rideBookingJson));
  } catch (error) {
    console.error('[admin] ride bookings failed:', error.message);
    res.status(500).json({ message: 'Ride bookings could not be loaded.' });
  }
});

/**
 * Admin cancellation of a ride offer. Paid seat bookings are refunded through the
 * central policy; unpaid holds are simply released. Nothing is deleted.
 */
router.delete('/rides/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride not found.' });
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: 'Ride not found.' });
    const reason = String(req.body?.reason || '').trim().slice(0, 500) || 'Removed by an administrator.';
    const refundPaid = req.body?.refundPaid !== false;

    ride.status = RIDE_STATUS.REMOVED;
    ride.verified = false;
    ride.removalReason = reason;
    ride.reviewedAt = new Date();
    ride.reviewedBy = req.user._id;
    await ride.save();

    // Unpaid holds are released: no money moved, so no refund is involved.
    const unpaid = await RideBooking.find({ rideId: ride._id, paymentStatus: { $ne: 'paid' }, status: { $nin: ['cancelled', 'cancelled_by_user', 'cancelled_by_owner', 'cancelled_by_admin', 'rejected'] } });
    for (const booking of unpaid) {
      booking.status = RIDE_BOOKING_STATUS.CANCELLED_BY_ADMIN;
      booking.cancellation = {
        cancelledBy: CANCELLED_BY.ADMIN, cancelledById: req.user._id, reason,
        cancelledAt: new Date(), originalAmount: 0, cancellationFee: 0, refundAmount: 0, finalAmount: 0
      };
      await booking.save();
      await Ride.updateOne({ _id: ride._id, seatsBooked: { $gte: booking.seats } }, { $inc: { seatsBooked: -booking.seats } });
      await notifyUser(booking.userId, {
        type: 'booking',
        title: 'Ride removed by admin',
        message: `The ${ride.from} to ${ride.to} ride was removed by an administrator. No payment was collected for your seat.`,
        data: { rideBookingId: booking._id.toString() }
      });
    }

    // Paid bookings are refunded when asked for; otherwise they are preserved and
    // the admin is told exactly how much is outstanding.
    const paidBookings = await RideBooking.find({ rideId: ride._id, paymentStatus: 'paid', status: { $nin: ['cancelled', 'cancelled_by_user', 'cancelled_by_owner', 'cancelled_by_admin', 'rejected'] } });
    const results = [];
    let refundedTotal = 0;
    for (const booking of paidBookings) {
      if (!refundPaid) { results.push({ bookingId: idOf(booking._id), refunded: false, reason: 'Refund skipped at the administrator’s request.' }); continue; }
      const policy = computeCancellation({ amount: booking.totalAmount, actor: CANCELLED_BY.ADMIN, startsAt: ride.date, reason, flow: 'ride', platformFee: booking.quote?.platformFee });
      const plan = refundPlan({ amount: booking.totalAmount, fee: policy.cancellationFee, method: booking.paymentMethod });
      const outcome = plan.refundable && booking.paymentMethod === 'razorpay'
        ? await refundRecord({
          method: booking.paymentMethod,
          paymentReference: booking.razorpayPaymentId || booking.paymentReference,
          amount: plan.refundAmount,
          receipt: `REVEX-RIDE-ADM-${booking._id}`.slice(0, 40),
          note: 'Admin removed the ride'
        })
        : { ok: true, plan, refund: { id: '', amount: plan.refundAmount, status: 'manual', processedAt: new Date() } };

      booking.status = RIDE_BOOKING_STATUS.CANCELLED_BY_ADMIN;
      booking.cancellation = {
        cancelledBy: CANCELLED_BY.ADMIN, cancelledById: req.user._id, reason, cancelledAt: new Date(),
        originalAmount: policy.originalAmount, cancellationFee: policy.cancellationFee,
        cancellationFeePercent: policy.cancellationFeePercent, refundAmount: plan.refundAmount,
        finalAmount: plan.refundAmount, platformFee: policy.platformFee,
        withinFreeWindow: policy.withinFreeWindow, policyVersion: policy.policyVersion, explanation: policy.explanation
      };
      booking.paymentStatus = plan.refundable ? 'refunded' : 'paid';
      booking.refund = {
        id: outcome.refund?.id || '', amount: plan.refundAmount,
        status: outcome.ok ? (outcome.refund?.status || 'manual') : 'failed',
        processedAt: new Date(),
        note: outcome.ok ? plan.note : (outcome.reason || 'Refund could not be processed automatically.')
      };
      await booking.save();
      await Ride.updateOne({ _id: ride._id, seatsBooked: { $gte: booking.seats } }, { $inc: { seatsBooked: -booking.seats } });
      refundedTotal += plan.refundAmount;
      results.push({ bookingId: idOf(booking._id), refunded: outcome.ok, amount: plan.refundAmount, status: booking.refund.status, reason: outcome.ok ? '' : (outcome.reason || '') });
      await notifyUser(booking.userId, {
        type: 'booking',
        title: 'Ride removed by admin',
        message: `The ${ride.from} to ${ride.to} ride was removed by an administrator. ${plan.refundable ? `₹${plan.refundAmount} is refunded.` : 'No refund was due.'}`,
        data: { rideBookingId: booking._id.toString() }
      });
    }

    await notifyUser(ride.driverId, {
      type: 'vehicle',
      title: 'Ride offer removed',
      message: `Your ${ride.from} to ${ride.to} ride was removed by an administrator: ${reason}`,
      data: { rideId: ride._id.toString() }
    });

    res.json({
      success: true,
      message: `Ride offer removed. ${unpaid.length} unpaid seat(s) released, ${results.length} paid booking(s) processed, ₹${money(refundedTotal)} refunded.`,
      refundedTotal: money(refundedTotal),
      releasedUnpaid: unpaid.length,
      results
    });
  } catch (error) {
    console.error('[admin] ride remove failed:', error.message);
    res.status(500).json({ message: 'The ride offer could not be removed.' });
  }
});

/** Admin decision on a ride booking: confirm, complete, or cancel with refund. */
router.patch('/ride-bookings/:id/status', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  const requested = String(req.body.status || '').toLowerCase();
  if (!['cancelled', 'completed', 'confirmed', 'rejected'].includes(requested)) {
    return res.status(400).json({ message: 'Status must be cancelled, completed, confirmed or rejected.' });
  }
  try {
    const booking = await RideBooking.findById(req.params.id).populate('rideId', 'driverId from to date');
    if (!booking) return res.status(404).json({ message: 'Ride booking not found.' });
    if (['cancelled', 'cancelled_by_user', 'cancelled_by_owner', 'cancelled_by_admin'].includes(booking.status)) {
      return res.status(409).json({ message: 'This ride booking is already cancelled.' });
    }

    if (requested === 'cancelled') {
      const reason = String(req.body.reason || '').trim().slice(0, 500);
      if (!reason) return res.status(400).json({ message: 'Enter a cancellation reason.' });
      const paid = booking.paymentStatus === 'paid';
      const policy = computeCancellation({ amount: paid ? booking.totalAmount : 0, actor: CANCELLED_BY.ADMIN, startsAt: booking.rideId?.date, reason, flow: 'ride', platformFee: booking.quote?.platformFee });
      const plan = refundPlan({ amount: paid ? booking.totalAmount : 0, fee: policy.cancellationFee, method: booking.paymentMethod });
      const outcome = plan.refundable && paid
        ? await refundRecord({
          method: booking.paymentMethod,
          paymentReference: booking.razorpayPaymentId || booking.paymentReference,
          amount: plan.refundAmount,
          receipt: `REVEX-RB-ADM-${booking._id}`.slice(0, 40),
          note: 'Admin cancelled the seat'
        })
        : { ok: true, plan, refund: null };

      booking.status = RIDE_BOOKING_STATUS.CANCELLED_BY_ADMIN;
      booking.cancellation = {
        cancelledBy: CANCELLED_BY.ADMIN, cancelledById: req.user._id, reason, cancelledAt: new Date(),
        originalAmount: policy.originalAmount, cancellationFee: policy.cancellationFee,
        cancellationFeePercent: policy.cancellationFeePercent, refundAmount: plan.refundAmount,
        finalAmount: plan.refundAmount, platformFee: policy.platformFee,
        withinFreeWindow: policy.withinFreeWindow, policyVersion: policy.policyVersion, explanation: policy.explanation
      };
      if (paid) {
        booking.paymentStatus = plan.refundable ? 'refunded' : 'paid';
        booking.refund = {
          id: outcome.refund?.id || '', amount: plan.refundAmount,
          status: outcome.ok ? (outcome.refund?.status || (outcome.refund ? 'manual' : 'not_required')) : 'failed',
          processedAt: new Date(),
          note: outcome.ok ? plan.note : (outcome.reason || 'Refund could not be processed automatically.')
        };
      }
      await booking.save();
      await Ride.updateOne({ _id: booking.rideId?._id || booking.rideId, seatsBooked: { $gte: booking.seats } }, { $inc: { seatsBooked: -booking.seats } });
      await notifyUser(booking.userId, {
        type: 'booking',
        title: 'Ride booking cancelled by admin',
        message: `An administrator cancelled your seat on the ${booking.rideId?.from || ''} to ${booking.rideId?.to || ''} ride.${reason ? ` Reason: ${reason}` : ''} ${plan.refundable ? `₹${plan.refundAmount} is refunded.` : 'No refund was due.'}`,
        data: { rideBookingId: booking._id.toString() }
      });
      return res.json({
        message: outcome.ok
          ? `Ride booking cancelled. ${plan.refundable ? `₹${plan.refundAmount} refunded.` : 'No refund was due.'}`
          : 'Ride booking cancelled, but the automatic refund failed and must be processed manually.',
        booking: rideBookingJson(booking),
        cancellation: booking.cancellation,
        refund: { ...plan, gateway: outcome.refund || null, gatewayError: outcome.ok ? null : (outcome.reason || '') }
      });
    }

    if (requested === 'confirmed' && booking.paymentStatus !== 'paid') {
      return res.status(400).json({ message: 'Only a paid seat request can be confirmed.' });
    }
    booking.status = requested === 'rejected' ? RIDE_BOOKING_STATUS.REJECTED
      : requested === 'completed' ? RIDE_BOOKING_STATUS.COMPLETED
        : RIDE_BOOKING_STATUS.CONFIRMED;
    booking.ownerDecision = {
      decision: requested === 'rejected' ? 'rejected' : 'approved',
      reason: String(req.body.reason || '').trim().slice(0, 1000),
      decidedAt: new Date(),
      decidedBy: req.user._id
    };
    await booking.save();
    await notifyUser(booking.userId, {
      type: 'booking',
      title: `Ride booking ${requested}`,
      message: `An administrator marked your seat on the ${booking.rideId?.from || ''} to ${booking.rideId?.to || ''} ride as ${RIDE_BOOKING_STATUS_LABELS[booking.status] || requested}.`,
      data: { rideBookingId: booking._id.toString() }
    });
    return res.json({ message: 'Ride booking updated.', booking: rideBookingJson(booking) });
  } catch (error) {
    console.error('[admin] ride booking status failed:', error.message);
    res.status(500).json({ message: 'The ride booking could not be updated.' });
  }
});

/* ------------------------------------------------------------- ride review */

router.patch('/rides/:id/verify', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride not found.' });
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: 'Ride not found.' });
    const decision = String(req.body.decision || (req.body.verified === true || req.body.verified === 'true' ? 'approve' : 'reject')).toLowerCase();
    const reason = String(req.body.reason || '').trim().slice(0, 1000);
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ message: 'Choose approve or reject.' });
    if (decision === 'reject' && !reason) return res.status(400).json({ message: 'Enter a rejection reason.' });
    ride.verified = decision === 'approve';
    ride.status = decision === 'approve' ? RIDE_STATUS.APPROVED : RIDE_STATUS.REJECTED;
    ride.rejectionReason = decision === 'reject' ? reason : '';
    ride.removalReason = '';
    ride.reviewedAt = new Date();
    ride.reviewedBy = req.user._id;
    await ride.save();
    await notifyUser(ride.driverId, {
      type: 'vehicle',
      title: decision === 'approve' ? 'Ride offer approved' : 'Ride offer needs attention',
      message: decision === 'approve' ? `${ride.from} to ${ride.to} is visible on Find a Ride.` : `${ride.from} to ${ride.to} was rejected: ${reason}`,
      data: { rideId: ride._id.toString() }
    });
    res.json({ ...rideJson(ride), message: decision === 'approve' ? 'Ride offer approved.' : 'Ride offer rejected.' });
  } catch (error) {
    console.error('[admin] ride verify failed:', error.message);
    res.status(500).json({ message: 'Ride moderation failed.' });
  }
});

/* ------------------------------------------------------------- user admin */

router.delete('/users/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Account not found.' });
  if (req.params.id === req.user._id.toString()) {
    return res.status(400).json({ message: 'You cannot delete your own admin account.', code: 'SELF_DELETE' });
  }
  try {
    const user = await User.findById(req.params.id).select('name email role').lean();
    if (!user) return res.status(404).json({ message: 'Account not found.' });

    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    if (!reason) return res.status(400).json({ message: 'Enter a reason before deleting this account.' });
    const confirmed = req.body?.confirm === true || req.body?.confirm === 'true';
    if (!confirmed) return res.status(400).json({ message: 'Deletion must be confirmed.', code: 'CONFIRMATION_REQUIRED' });

    // Preview what will be removed so the UI can warn before committing.
    const [vehicleCount, bookingCount, rideCount] = await Promise.all([
      Vehicle.countDocuments({ ownerId: user._id }),
      Booking.countDocuments({ $or: [{ userId: user._id }, { ownerId: user._id }] }),
      Ride.countDocuments({ driverId: user._id })
    ]);

    const result = await deleteUserCascade(user._id, { allowAdmin: true });
    if (!result.deleted) return res.status(400).json({ message: result.reason || 'Account could not be deleted.' });

    res.json({
      success: true,
      message: `${user.name} (${user.email}) was deleted permanently. ${summarise(result)}`,
      reason,
      preview: { vehicles: vehicleCount, bookings: bookingCount, rides: rideCount },
      counts: result.counts,
      deletedId: idOf(user._id)
    });
  } catch (error) {
    console.error('[admin] user delete failed:', error.message);
    res.status(500).json({ message: 'Account could not be deleted.' });
  }
});

module.exports = router;

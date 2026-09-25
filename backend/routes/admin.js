const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Vehicle = require('../models/Vehicle');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Ride = require('../models/Ride');
const RideBooking = require('../models/RideBooking');
const Agreement = require('../models/Agreement');
const MonthlyBookingCounter = require('../models/MonthlyBookingCounter');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../utils/notify');
<<<<<<< HEAD
const { applyEarningsDelta, hasEarned } = require('../utils/earnings');
const { deleteVehicleCascade, deleteUserCascade, summarise } = require('../utils/hardDelete');
=======
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

function idOf(value) {
  if (!value) return '';
  if (typeof value === 'object') return String(value._id || value.id || '');
  return String(value);
}

function vehicleStatus(vehicle) {
  if (vehicle.status === 'available') return 'approved';
  if (vehicle.status === 'unavailable') return 'removed';
  return vehicle.status || 'pending';
}

function vehicleJson(vehicle) {
  const value = vehicle && typeof vehicle.toObject === 'function' ? vehicle.toObject() : { ...(vehicle || {}) };
  const owner = value.ownerId && typeof value.ownerId === 'object' ? value.ownerId : null;
  const status = vehicleStatus(value);
  return {
    ...value,
    id: idOf(value._id || value.id),
    ownerId: idOf(value.ownerId),
    owner: owner ? { id: idOf(owner), name: owner.name || '', email: owner.email || '', phone: owner.phone || '' } : undefined,
    category: value.category || value.type || 'Other',
    type: value.type || value.category || 'Other',
    status,
<<<<<<< HEAD
    statusLabel: ({ pending: 'Pending Approval', approved: 'Approved', rejected: 'Rejected', removed: 'Removed (legacy)' })[status] || 'Pending Approval',
=======
    statusLabel: ({ pending: 'Pending Approval', approved: 'Approved', rejected: 'Rejected', removed: 'Removed / Deregistered' })[status] || 'Pending Approval',
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
    image: value.image || value.vehiclePicture || '',
    vehiclePicture: value.vehiclePicture || value.image || '',
    documents: Array.isArray(value.documents) ? value.documents : []
  };
}

async function releaseBookingCounter(booking) {
  if (!booking?.monthlySlot || !booking?.monthKey) return;
  await MonthlyBookingCounter.findOneAndUpdate({ userId: booking.userId, monthKey: booking.monthKey, count: { $gt: 0 } }, { $inc: { count: -1 } });
  await Booking.updateOne({ _id: booking._id }, { $unset: { monthlySlot: 1 } });
}

function ownerSummaryQuery(ownerId) {
  return [
    { $match: { vehicleId: { $in: ownerId.vehicleIds } } },
    { $group: {
      _id: '$vehicleId',
      totalBookings: { $sum: 1 },
      completedBookings: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
<<<<<<< HEAD
      pendingBookings: { $sum: { $cond: [{ $in: ['$status', ['payment_pending', 'pending_owner']] }, 1, 0] } },
      activeBookings: { $sum: { $cond: [{ $in: ['$status', ['confirmed', 'pending_owner']] }, 1, 0] } },
      cancelledBookings: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
      rejectedBookings: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
      grossEarnings: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentStatus', 'paid'] }, { $in: ['$status', ['confirmed', 'completed']] }] }, '$grandTotal', 0] } },
      ownerEarnings: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentStatus', 'paid'] }, { $in: ['$status', ['confirmed', 'completed']] }] }, { $multiply: ['$grandTotal', 0.9] }, 0] } }
=======
      activeBookings: { $sum: { $cond: [{ $in: ['$status', ['confirmed', 'pending_owner']] }, 1, 0] } },
      grossEarnings: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentStatus', 'paid'] }, { $ne: ['$status', 'cancelled'] }] }, '$grandTotal', 0] } },
      ownerEarnings: { $sum: { $cond: [{ $and: [{ $eq: ['$paymentStatus', 'paid'] }, { $ne: ['$status', 'cancelled'] }] }, { $multiply: ['$grandTotal', 0.9] }, 0] } }
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
    } }
  ];
}

router.get('/summary', async (req, res) => {
  try {
    const [users, owners, vehicles, bookings, rides, pendingVehicles, approvedVehicles, rejectedVehicles, removedVehicles, paidAgg, approvedAgg, ridePaidAgg] = await Promise.all([
      User.countDocuments({ isActive: { $ne: false } }),
      User.countDocuments({ role: 'owner', isActive: { $ne: false } }),
      Vehicle.countDocuments(),
      Booking.countDocuments(),
      Ride.countDocuments(),
      Vehicle.countDocuments({ status: 'pending' }),
      Vehicle.countDocuments({ status: 'approved' }),
      Vehicle.countDocuments({ status: 'rejected' }),
      Vehicle.countDocuments({ status: 'removed' }),
      Booking.aggregate([{ $match: { paymentStatus: 'paid', status: { $ne: 'cancelled' } } }, { $group: { _id: null, gross: { $sum: '$grandTotal' }, commission: { $sum: { $multiply: ['$grandTotal', 0.10] } } } }]),
      Booking.aggregate([{ $match: { paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } } }, { $group: { _id: null, gross: { $sum: '$grandTotal' } } }]),
      RideBooking.aggregate([{ $match: { paymentStatus: 'paid', status: { $ne: 'cancelled' } } }, { $group: { _id: null, gross: { $sum: '$totalAmount' }, commission: { $sum: { $multiply: ['$totalAmount', 0.10] } } } }])
    ]);
    const gross = (paidAgg[0]?.gross || 0) + (ridePaidAgg[0]?.gross || 0);
    const approvedRevenue = (approvedAgg[0]?.gross || 0) + (ridePaidAgg[0]?.gross || 0);
    const commission = (paidAgg[0]?.commission || 0) + (ridePaidAgg[0]?.commission || 0);
    const approvedCommission = Math.round(approvedRevenue * 0.10);
    res.json({
      users, owners, vehicles, bookings, rides,
      pendingVehicleVerification: pendingVehicles,
      approvedVehicles, rejectedVehicles, removedVehicles,
      totalRevenue: gross,
      approvedRevenue,
      grossRevenue: gross,
      commission,
      ownerPayout: approvedRevenue - approvedCommission,
      rideBookings: await RideBooking.countDocuments()
    });
  } catch (error) {
    res.status(500).json({ message: 'Admin summary could not be loaded.' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const users = await User.find({}).select('-passwordHash -resetPasswordToken -resetPasswordExpires').sort({ createdAt: -1 }).lean();
    res.json(users.map(user => ({ ...user, id: idOf(user._id), active: user.isActive !== false })));
  } catch (error) {
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
    res.status(500).json({ message: 'Could not create admin. Please try again.' });
  }
});

router.get('/owners', async (req, res) => {
  try {
    const owners = await User.find({ role: 'owner' }).select('name email phone createdAt isActive ownerEarnings').sort({ createdAt: -1 }).lean();
    const rows = await Promise.all(owners.map(async owner => {
      const vehicles = await Vehicle.find({ ownerId: owner._id }).select('status verified').lean();
      const vehicleIds = vehicles.map(v => v._id);
<<<<<<< HEAD
      const [bookings, earnings, statusRows] = await Promise.all([
        Booking.countDocuments({ vehicleId: { $in: vehicleIds } }),
        Booking.aggregate([{ $match: { vehicleId: { $in: vehicleIds }, paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } } }, { $group: { _id: null, total: { $sum: { $multiply: ['$grandTotal', 0.9] } } } }]),
        Booking.aggregate([{ $match: { vehicleId: { $in: vehicleIds } } }, { $group: { _id: '$status', count: { $sum: 1 } } }])
      ]);
      const statusCounts = Object.fromEntries(statusRows.map(item => [item._id, item.count]));
=======
      const [bookings, earnings] = await Promise.all([
        Booking.countDocuments({ $or: [{ ownerId: owner._id }, { vehicleId: { $in: vehicleIds } }] }),
        Booking.aggregate([{ $match: { $or: [{ ownerId: owner._id }, { vehicleId: { $in: vehicleIds } }], paymentStatus: 'paid', status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: { $multiply: ['$grandTotal', 0.9] } } } }])
      ]);
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
      return {
        id: owner._id.toString(), name: owner.name, email: owner.email, phone: owner.phone || '', active: owner.isActive !== false,
        totalVehicles: vehicles.length,
        approvedVehicles: vehicles.filter(v => vehicleStatus(v) === 'approved').length,
        pendingVehicles: vehicles.filter(v => vehicleStatus(v) === 'pending').length,
        rejectedVehicles: vehicles.filter(v => vehicleStatus(v) === 'rejected').length,
        removedVehicles: vehicles.filter(v => vehicleStatus(v) === 'removed').length,
        totalBookings: bookings,
<<<<<<< HEAD
        pendingBookings: statusCounts.pending_owner || statusCounts.pending || 0,
        approvedBookings: statusCounts.confirmed || 0,
        activeBookings: statusCounts.confirmed || 0,
        completedBookings: statusCounts.completed || 0,
        cancelledBookings: statusCounts.cancelled || 0,
        rejectedBookings: statusCounts.rejected || 0,
=======
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
        totalEarnings: Math.round(earnings[0]?.total || 0)
      };
    }));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Owner summary could not be loaded.' });
  }
});

router.get('/owners/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Owner not found.' });
  try {
<<<<<<< HEAD
    // NOTE: `role` MUST stay in the projection — it is checked on the next line.
    // Omitting it made this endpoint return 404 for every owner.
    const owner = await User.findById(req.params.id).select('name email phone role createdAt isActive ownerEarnings').lean();
=======
    const owner = await User.findById(req.params.id).select('name email phone createdAt isActive ownerEarnings').lean();
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
    if (!owner || owner.role !== 'owner') return res.status(404).json({ message: 'Owner not found.' });
    const vehicles = await Vehicle.find({ ownerId: owner._id }).populate('ownerId', 'name email phone').sort({ createdAt: -1 }).lean();
    const vehicleIds = vehicles.map(v => v._id);
    const stats = await Booking.aggregate(ownerSummaryQuery({ vehicleIds }));
    const statsMap = Object.fromEntries(stats.map(item => [idOf(item._id), item]));
    const recent = await Booking.find({ $or: [{ ownerId: owner._id }, { vehicleId: { $in: vehicleIds } }] }).populate('userId', 'name email').populate('vehicleId', 'name category type numberPlate').sort({ createdAt: -1 }).limit(20).lean();
    res.json({
      owner: { id: owner._id.toString(), name: owner.name, email: owner.email, phone: owner.phone || '', active: owner.isActive !== false, joinedAt: owner.createdAt },
      totals: {
        totalVehicles: vehicles.length,
        approvedVehicles: vehicles.filter(v => vehicleStatus(v) === 'approved').length,
        pendingVehicles: vehicles.filter(v => vehicleStatus(v) === 'pending').length,
        rejectedVehicles: vehicles.filter(v => vehicleStatus(v) === 'rejected').length,
        removedVehicles: vehicles.filter(v => vehicleStatus(v) === 'removed').length,
        totalBookings: stats.reduce((sum, item) => sum + item.totalBookings, 0),
<<<<<<< HEAD
        pendingBookings: stats.reduce((sum, item) => sum + (item.pendingBookings || 0), 0),
        activeBookings: stats.reduce((sum, item) => sum + (item.activeBookings || 0), 0),
        completedBookings: stats.reduce((sum, item) => sum + (item.completedBookings || 0), 0),
        cancelledBookings: stats.reduce((sum, item) => sum + (item.cancelledBookings || 0), 0),
        rejectedBookings: stats.reduce((sum, item) => sum + (item.rejectedBookings || 0), 0),
=======
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
        totalEarnings: Math.round(stats.reduce((sum, item) => sum + item.ownerEarnings, 0))
      },
      vehicles: vehicles.map(vehicle => {
        const item = statsMap[idOf(vehicle._id)] || {};
<<<<<<< HEAD
        return { ...vehicleJson(vehicle), totalBookings: item.totalBookings || 0, completedBookings: item.completedBookings || 0, activeBookings: item.activeBookings || 0, pendingBookings: item.pendingBookings || 0, cancelledBookings: item.cancelledBookings || 0, rejectedBookings: item.rejectedBookings || 0, grossEarnings: Math.round(item.grossEarnings || 0), totalEarnings: Math.round(item.ownerEarnings || 0) };
=======
        return { ...vehicleJson(vehicle), totalBookings: item.totalBookings || 0, completedBookings: item.completedBookings || 0, activeBookings: item.activeBookings || 0, grossEarnings: Math.round(item.grossEarnings || 0), totalEarnings: Math.round(item.ownerEarnings || 0) };
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
      }),
      recentBookings: recent.map(booking => ({ ...booking, id: idOf(booking._id), vehicleId: booking.vehicleId ? { ...booking.vehicleId, id: idOf(booking.vehicleId) } : null, userId: booking.userId ? { ...booking.userId, id: idOf(booking.userId) } : null }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Owner details could not be loaded.' });
  }
});

<<<<<<< HEAD
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
    res.status(500).json({ message: 'Agreement could not be loaded.' });
  }
});

router.get('/vehicles', async (req, res) => {
  try {
    const status = String(req.query.status || 'all').toLowerCase();
    const query = status === 'all' ? {} : { status };
    const vehicles = await Vehicle.find(query).populate('ownerId', 'name email phone').sort({ createdAt: -1 }).lean();
    res.json(vehicles.map(vehicleJson));
  } catch (error) {
    res.status(500).json({ message: 'Vehicle inventory could not be loaded.' });
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
    vehicle.status = decision === 'approve' ? 'approved' : 'rejected';
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
    res.status(500).json({ message: 'Vehicle moderation failed. Please try again.' });
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

=======
router.get('/vehicles', async (req, res) => {
  try {
    const status = String(req.query.status || 'all').toLowerCase();
    const query = status === 'all' ? {} : { status };
    const vehicles = await Vehicle.find(query).populate('ownerId', 'name email phone').sort({ createdAt: -1 }).lean();
    res.json(vehicles.map(vehicleJson));
  } catch (error) {
    res.status(500).json({ message: 'Vehicle inventory could not be loaded.' });
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
    vehicle.status = decision === 'approve' ? 'approved' : 'rejected';
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
    res.status(500).json({ message: 'Vehicle moderation failed. Please try again.' });
  }
});

router.delete('/vehicles/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Vehicle not found.' });
  try {
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) return res.status(404).json({ message: 'We could not find that vehicle. Please try again.' });
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    if (!reason) return res.status(400).json({ message: 'Enter a reason before deregistering this vehicle.' });
    vehicle.status = 'removed';
    vehicle.verified = false;
    vehicle.availability = 'unavailable';
    vehicle.removalReason = reason;
    vehicle.removedAt = new Date();
    await vehicle.save();
    await notifyUser(vehicle.ownerId, { type: 'vehicle', title: 'Vehicle deregistered', message: `${vehicle.name} was deregistered: ${reason}`, data: { vehicleId: vehicle._id.toString() } });
    res.json({ message: 'Vehicle deregistered. Historical bookings were preserved.', vehicle: vehicleJson(vehicle) });
  } catch (error) {
    res.status(500).json({ message: 'Vehicle could not be deregistered.' });
  }
});

>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
router.get('/income', async (req, res) => {
  try {
    const paidMatch = { paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } };
    const [rentalPaid, rentalPending, ridePaid, completedAgg, completedCount, pendingCount, cancelledCount, byVehicle] = await Promise.all([
      Booking.aggregate([{ $match: paidMatch }, { $group: { _id: null, gross: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]),
      Booking.aggregate([{ $match: { paymentStatus: 'pending', status: 'payment_pending' } }, { $group: { _id: null, gross: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]),
      RideBooking.aggregate([{ $match: paidMatch }, { $group: { _id: null, gross: { $sum: '$totalAmount' }, count: { $sum: 1 } } }]),
      Booking.aggregate([{ $match: { paymentStatus: 'paid', status: 'completed' } }, { $group: { _id: null, gross: { $sum: '$grandTotal' } } }]),
      Booking.countDocuments({ paymentStatus: 'paid', status: 'completed' }),
      Booking.countDocuments({ status: { $in: ['payment_pending', 'pending_owner'] } }),
      Booking.countDocuments({ status: 'cancelled' }),
<<<<<<< HEAD
      Booking.aggregate([{ $match: paidMatch }, { $group: { _id: '$vehicleId', bookings: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } }, { $sort: { revenue: -1 } }])
=======
      Booking.aggregate([{ $match: paidMatch }, { $group: { _id: '$vehicleId', bookings: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } }, { $sort: { revenue: -1 } }, { $limit: 50 }])
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
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
    const rentalGross = rentalPaid[0]?.gross || 0;
    const rideGross = ridePaid[0]?.gross || 0;
    const gross = rentalGross + rideGross;
    const commission = Math.round(gross * 0.10);
    const recent = await Booking.find(paidMatch).populate('userId', 'name').populate('vehicleId', 'name').sort({ createdAt: -1 }).limit(10).lean();
    res.json({
      totalRevenue: gross, completedRevenue: completedAgg[0]?.gross || 0, pendingRevenue: rentalPending[0]?.gross || 0,
      commission, ownerPayout: gross - commission, completedBookings: completedCount,
      pendingBookings: pendingCount, cancelledBookings: cancelledCount,
      rentalBookings: rentalPaid[0]?.count || 0, rideBookings: ridePaid[0]?.count || 0,
      revenueByVehicle: byVehicle.map(row => { const vehicle = vehicleMap[idOf(row._id)]; return { vehicleId: idOf(row._id), vehicleName: vehicle?.name || 'Vehicle', vehicleType: vehicle?.category || vehicle?.type || '', ownerName: ownerMap[idOf(vehicle?.ownerId)] || '', bookings: row.bookings, revenue: row.revenue, ownerShare: Math.round(row.revenue * 0.9) }; }),
      revenueByOwner: Object.values(byOwner).map(item => ({ ...item, ownerShare: Math.round(item.revenue * 0.9) })).sort((a, b) => b.revenue - a.revenue),
      recent: recent.map(booking => ({ id: idOf(booking._id), vehicle: booking.vehicleId?.name || 'Vehicle', renter: booking.userId?.name || 'Renter', amount: booking.grandTotal || booking.totalAmount, status: booking.status, date: booking.createdAt }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Income data could not be loaded.' });
  }
});

router.get('/bookings', async (req, res) => {
  const docs = await Booking.find({}).populate('userId', 'name email').populate('vehicleId', 'name type category location numberPlate fuelType').sort({ createdAt: -1 }).lean();
  res.json(docs.map(booking => ({ ...booking, id: idOf(booking._id) })));
});

router.patch('/bookings/:id/status', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  const allowed = ['cancelled', 'completed', 'confirmed'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ message: 'Admin can set booking status to cancelled, completed or confirmed.' });
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ message: 'Booking not found.' });
  if (req.body.status === 'confirmed' && (booking.paymentStatus !== 'paid' || booking.status !== 'pending_owner')) return res.status(400).json({ message: 'Only a paid request awaiting owner approval can be confirmed.' });
  if (req.body.status === 'completed' && (booking.paymentStatus !== 'paid' || !['confirmed', 'completed'].includes(booking.status))) return res.status(400).json({ message: 'Only a confirmed paid booking can be marked completed.' });
  if (req.body.status === 'cancelled' && booking.paymentStatus === 'paid') return res.status(400).json({ message: 'A paid booking cannot be cancelled without a refund process.' });
  booking.status = req.body.status;
  await booking.save();
  if (req.body.status === 'confirmed') {
    const agreement = await Agreement.findOne({ bookingId: booking._id });
    if (agreement) { agreement.acceptedByOwner = true; agreement.ownerAcceptedAt = new Date(); agreement.agreementStatus = 'approved'; await agreement.save(); }
<<<<<<< HEAD
    await applyEarningsDelta(booking, 1);
  }
  if (req.body.status === 'cancelled') {
    // Reverse any earnings already credited for a confirmed booking.
    if (hasEarned(booking.status) && booking.paymentStatus === 'paid') await applyEarningsDelta(booking, -1);
    await releaseBookingCounter(booking);
  }
=======
    const ownerShare = Math.round((booking.grandTotal || booking.totalAmount || 0) * 0.9);
    const vehicle = await Vehicle.findById(booking.vehicleId).select('ownerId').lean();
    if (vehicle?.ownerId) { await Vehicle.findByIdAndUpdate(booking.vehicleId, { $inc: { totalEarnings: ownerShare, totalRentals: 1 } }); await User.findByIdAndUpdate(vehicle.ownerId, { $inc: { ownerEarnings: ownerShare } }); }
  }
  if (req.body.status === 'cancelled') await releaseBookingCounter(booking);
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  await notifyUser(booking.userId, { type: 'booking', title: 'Booking status updated', message: `Your booking is now ${req.body.status}.`, data: { bookingId: booking._id.toString() } });
  res.json({ ...booking.toObject(), id: booking._id.toString() });
});

<<<<<<< HEAD
// Note: use PATCH /api/admin/bookings/:id/status to change booking status.
// The old POST /bookings/cancel duplicate was removed.

router.get('/ride-bookings', async (req, res) => {
  const docs = await RideBooking.find({}).populate('userId', 'name email').populate('rideId').sort({ createdAt: -1 }).lean();
  res.json(docs.map(booking => ({ ...booking, id: idOf(booking._id) })));
});

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
=======
router.post('/bookings/cancel', async (req, res) => {
  if (!mongoose.isValidObjectId(req.body.id)) return res.status(400).json({ message: 'Booking ID is required.' });
  const booking = await Booking.findById(req.body.id);
  if (!booking) return res.status(404).json({ message: 'Booking not found.' });
  if (booking.paymentStatus === 'paid') return res.status(400).json({ message: 'A paid booking cannot be cancelled without a refund process.' });
  booking.status = 'cancelled';
  await booking.save();
  await releaseBookingCounter(booking);
  res.json({ success: true, message: 'Booking cancelled by admin.', booking: { ...booking.toObject(), id: booking._id.toString() } });
});

router.get('/ride-bookings', async (req, res) => {
  const docs = await RideBooking.find({}).populate('userId', 'name email').populate('rideId').sort({ createdAt: -1 }).lean();
  res.json(docs.map(booking => ({ ...booking, id: idOf(booking._id) })));
});

router.delete('/users/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Account not found.' });
  if (req.params.id === req.user._id.toString()) return res.status(400).json({ message: 'You cannot deactivate your own admin account.' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'Account not found.' });
  if (user.role === 'admin' && await User.countDocuments({ role: 'admin', isActive: { $ne: false } }) <= 1) return res.status(400).json({ message: 'Cannot deactivate the last active admin account.' });
  user.isActive = false;
  user.deactivatedAt = new Date();
  await user.save();
  res.json({ success: true, message: 'Account deactivated. Historical records were preserved.' });
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
});

router.delete('/rides/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride not found.' });
  const ride = await Ride.findById(req.params.id);
  if (!ride) return res.status(404).json({ message: 'Ride not found.' });
  ride.status = 'removed';
  ride.verified = false;
  await ride.save();
<<<<<<< HEAD
  // Only unpaid seats are auto-cancelled; paid bookings are preserved so revenue
  // is never silently zeroed without a refund decision.
  const cancelled = await RideBooking.updateMany({ rideId: ride._id, status: 'payment_pending' }, { status: 'cancelled' });
  res.json({ success: true, message: `Ride offer removed. ${cancelled.modifiedCount || 0} unpaid seat booking(s) cancelled; paid bookings were preserved.` });
=======
  await RideBooking.updateMany({ rideId: ride._id, status: { $in: ['payment_pending', 'confirmed'] } }, { status: 'cancelled' });
  res.json({ success: true, message: 'Ride offer removed. Historical seat bookings were preserved.' });
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
});

router.patch('/ride-bookings/:id/status', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  const allowed = ['cancelled', 'completed', 'confirmed'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ message: 'Invalid ride booking status.' });
  const booking = await RideBooking.findById(req.params.id);
  if (!booking) return res.status(404).json({ message: 'Ride booking not found.' });
<<<<<<< HEAD
  if (req.body.status === 'cancelled' && booking.paymentStatus === 'paid') {
    return res.status(400).json({ message: 'A paid ride booking cannot be cancelled without a refund process.' });
  }
  if (req.body.status === 'cancelled' && booking.status === 'cancelled') {
    return res.status(409).json({ message: 'This ride booking is already cancelled.' });
  }
=======
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  booking.status = req.body.status;
  await booking.save();
  res.json({ ...booking.toObject(), id: booking._id.toString() });
});

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
    ride.status = decision === 'approve' ? 'approved' : 'rejected';
    ride.rejectionReason = decision === 'reject' ? reason : '';
    ride.reviewedAt = new Date();
    ride.reviewedBy = req.user._id;
    await ride.save();
    await notifyUser(ride.driverId, { type: 'vehicle', title: decision === 'approve' ? 'Ride offer approved' : 'Ride offer needs attention', message: decision === 'approve' ? `${ride.from} to ${ride.to} is visible on Find a Ride.` : `${ride.from} to ${ride.to} was rejected: ${reason}`, data: { rideId: ride._id.toString() } });
    res.json({ ...ride.toObject(), id: ride._id.toString() });
  } catch (error) {
    res.status(500).json({ message: 'Ride moderation failed.' });
  }
});

module.exports = router;

const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
let Razorpay = null;
try { Razorpay = require('razorpay'); } catch { Razorpay = null; }
const Ride = require('../models/Ride');
const RideBooking = require('../models/RideBooking');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../utils/notify');
const { normalizeMediaUrl } = require('../utils/media');

const router = express.Router();

function razorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

const razorpayClient = razorpayConfigured() && Razorpay
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

async function createRazorpayOrder(payload) {
  if (!razorpayClient) {
    const error = new Error('Razorpay SDK is not available on this server. Run npm install.');
    error.statusCode = 503;
    throw error;
  }
  return razorpayClient.orders.create(payload);
}

function signaturesMatch(expected, received) {
  if (typeof received !== 'string' || !/^[a-f0-9]+$/i.test(received) || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'));
}

function idOf(value) {
  if (!value) return '';
  return String(typeof value === 'object' ? value._id || value.id : value);
}

function serializeRide(ride, { includePrivate = false } = {}) {
  const value = ride && typeof ride.toObject === 'function' ? ride.toObject() : { ...(ride || {}) };
  const status = value.status === 'available' ? 'approved' : (value.status || 'pending');
  const result = { ...value, id: idOf(value._id || value.id), driverId: idOf(value.driverId), vehicleImage: normalizeMediaUrl(value.vehicleImage, ''), status, statusLabel: ({ pending: 'Pending Approval', approved: 'Available', rejected: 'Rejected', removed: 'Removed' })[status] || 'Pending Approval' };
  if (!includePrivate) { delete result.driverPhone; delete result.driverId; }
  return result;
}

function imageValue(value) {
  if (typeof value !== 'string' || !value) return '';
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^\/?(uploads|images|assets)\//i.test(value)) return normalizeMediaUrl(value, '');
  return '';
}

router.get('/', optionalAuth, async (req, res) => {
  try {
    const query = {};
    if (req.query.from) query.from = { $regex: String(req.query.from).trim().slice(0, 100), $options: 'i' };
    if (req.query.to) query.to = { $regex: String(req.query.to).trim().slice(0, 100), $options: 'i' };
    if (req.query.vehicleType) query.vehicleType = String(req.query.vehicleType);
    const requestedStatus = String(req.query.status || '').toLowerCase();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (req.query.date) {
      const date = new Date(req.query.date);
      if (!Number.isNaN(date.getTime())) { const next = new Date(date); next.setDate(next.getDate() + 1); query.date = { $gte: date, $lt: next }; }
    } else if (requestedStatus !== 'all') {
      query.date = { $gte: today };
    }
    // Mirrors GET /vehicles: the public "approved" filter is allowed for anyone,
    // while non-public statuses (pending/rejected/removed) stay admin-only.
    const publicStatuses = ['approved', 'available', ''];
    if (requestedStatus === 'all') {
      if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access is required to view all ride statuses.' });
      query.status = { $nin: ['removed'] };
    } else if (!publicStatuses.includes(requestedStatus) && req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access is required to view other ride statuses.' });
    } else {
      query.status = { $in: ['approved', 'available'] };
      query.verified = true;
    }
    const rides = await Ride.find(query).sort({ date: 1, time: 1 }).lean();
    res.json(rides.map(ride => serializeRide(ride, { includePrivate: req.user?.role === 'admin' || req.user?.role === 'owner' })));
  } catch (error) {
    res.status(500).json({ message: 'Rides could not be loaded. Please try again.' });
  }
});

router.get('/bookings/my', requireAuth, async (req, res) => {
  try {
    const docs = await RideBooking.find({ userId: req.user._id }).populate('rideId').sort({ createdAt: -1 }).lean();
    res.json(docs.map(booking => ({ ...booking, id: idOf(booking._id), type: 'ride', rideId: booking.rideId ? { ...booking.rideId, id: idOf(booking.rideId) } : null })));
  } catch (error) {
    res.status(500).json({ message: 'Ride bookings could not be loaded.' });
  }
});

router.get('/mine', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  const rides = await Ride.find(req.user.role === 'admin' && req.query.all === 'true' ? {} : { driverId: req.user._id }).sort({ date: 1 }).lean();
  res.json(rides.map(ride => serializeRide(ride, { includePrivate: true })));
});

router.post('/', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { from, to, date, time, seats, price, vehicle, vehicleType, fuelType, numberPlate, driverPhone, vehicleImage } = req.body;
    if (!from || !to || !date || !time || !vehicle || Number(seats) < 1 || Number(price) < 1) return res.status(400).json({ message: 'From, to, date, time, vehicle, seats and price are required.' });
    if (!['Bike', 'Scooter', 'Car', 'Other'].includes(vehicleType)) return res.status(400).json({ message: 'Vehicle type must be Bike, Scooter, Car or Other.' });
    const tripDate = new Date(date);
    if (Number.isNaN(tripDate.getTime())) return res.status(400).json({ message: 'Enter a valid ride date.' });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(tripDate); day.setHours(0, 0, 0, 0);
    if (day < today) return res.status(400).json({ message: 'Ride date cannot be in the past.' });
    if (vehicleImage && typeof vehicleImage === 'string' && vehicleImage.length > 4 * 1024 * 1024) return res.status(400).json({ message: 'Vehicle photo must be smaller than 3 MB.' });
    const ride = await Ride.create({
      driverId: req.user._id, driver: req.user.name, driverPhone: String(driverPhone || req.user.phone || '').trim(),
      from: String(from).trim(), to: String(to).trim(), date: tripDate, time: String(time),
      seats: Math.min(6, Number(seats)), price: Number(price), vehicle: String(vehicle).trim(), vehicleType,
      fuelType: ['Petrol', 'Diesel', 'Electric', 'CNG', 'Hybrid'].includes(fuelType) ? fuelType : 'Petrol',
      numberPlate: String(numberPlate || '').trim().toUpperCase(), vehicleImage: imageValue(vehicleImage),
      verified: req.user.role === 'admin', status: req.user.role === 'admin' ? 'approved' : 'pending'
    });
    res.status(201).json({ ...serializeRide(ride), message: ride.status === 'pending' ? 'Ride submitted. It will appear after admin approval.' : 'Ride published.' });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Ride could not be published.' });
  }
});

router.post('/:id/book', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that ride. Please try again.' });
  try {
    const requestedSeats = Number(req.body.seats || 1);
    if (!Number.isInteger(requestedSeats) || requestedSeats < 1 || requestedSeats > 6) return res.status(400).json({ message: 'Seat count must be a whole number from 1 to 6.' });
    const seats = requestedSeats;
    const ride = await Ride.findById(req.params.id);
    if (!ride || !['approved', 'available'].includes(ride.status) || !ride.verified) return res.status(404).json({ message: 'This ride is not available for booking.' });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (new Date(ride.date) < today) return res.status(400).json({ message: 'This ride has already departed and cannot be booked.' });
    if (idOf(ride.driverId) === idOf(req.user._id)) return res.status(400).json({ message: 'You cannot book your own ride.' });
    const activeBookings = await RideBooking.aggregate([{ $match: { rideId: ride._id, status: { $in: ['payment_pending', 'confirmed'] } } }, { $group: { _id: '$rideId', seats: { $sum: '$seats' } } }]);
    const available = Math.max(0, Number(ride.seats) - (activeBookings[0]?.seats || 0));
    if (seats > available) return res.status(409).json({ message: `Only ${available} seat(s) are available.` });
    const totalAmount = seats * Number(ride.price);
    const booking = await RideBooking.create({ rideId: ride._id, userId: req.user._id, seats, totalAmount, paymentMethod: 'razorpay', status: 'payment_pending', paymentStatus: 'pending' });
    await notifyUser(ride.driverId, { type: 'booking', title: 'New ride booking request', message: `${req.user.name} reserved ${seats} seat(s) on your ${ride.from} to ${ride.to} ride.`, data: { rideBookingId: booking._id.toString() } });
    res.status(201).json({ ...booking.toObject(), id: booking._id.toString(), payment: { method: 'razorpay', currency: 'INR', displayAmount: totalAmount } });
  } catch (error) {
    res.status(500).json({ message: 'Ride booking could not be created. Please try again.' });
  }
});

router.post('/bookings/:id/payment-order', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  if (!razorpayConfigured()) return res.status(503).json({ message: 'Online payment is not configured on this server.' });
  try {
    const booking = await RideBooking.findOne({ _id: req.params.id, userId: req.user._id, status: 'payment_pending', paymentStatus: 'pending' });
    if (!booking) return res.status(404).json({ message: 'Ride booking is no longer awaiting payment.' });

    const amount = Math.round(Number(booking.totalAmount) * 100);
    if (!Number.isInteger(amount) || amount < 100) return res.status(400).json({ message: 'Payment amount must be at least 100 paise.' });

    const order = await createRazorpayOrder({
      amount,
      currency: 'INR',
      receipt: `REVEX-RIDE-${booking._id}`
    });

    booking.paymentMethod = 'razorpay';
    booking.razorpayOrderId = order.id;
    await booking.save();

    return res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    const gatewayStatus = Number(error.statusCode || error.status || error?.error?.statusCode);
    const status = gatewayStatus === 401 ? 401 : (gatewayStatus === 503 ? 503 : 500);
    return res.status(status).json({
      message: status === 401
        ? 'Razorpay authentication failed. Check the server credentials.'
        : (error.error?.description || error.message || 'Could not create the Razorpay order.')
    });
  }
});

router.post('/bookings/:id/verify-payment', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  if (!razorpayConfigured()) return res.status(503).json({ message: 'Razorpay is not configured on this server.' });
  try {
    const booking = await RideBooking.findOne({ _id: req.params.id, userId: req.user._id });
    if (!booking) return res.status(404).json({ message: 'Ride booking not found.' });
    if (booking.paymentStatus === 'paid') return res.json({ success: true, message: 'Payment already verified.', booking: { ...booking.toObject(), id: booking._id.toString() } });

    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (!orderId || !paymentId || !signature) return res.status(400).json({ message: 'Payment verification data is incomplete.' });
    if (!booking.razorpayOrderId || orderId !== booking.razorpayOrderId) return res.status(400).json({ message: 'Payment order does not match this ride booking.' });

    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    if (!signaturesMatch(expected, signature)) {
      await RideBooking.findOneAndUpdate({ _id: booking._id, userId: req.user._id, paymentStatus: { $ne: 'paid' } }, { status: 'cancelled', paymentStatus: 'failed' });
      return res.status(400).json({ message: 'Payment verification failed. Your seat was not confirmed.' });
    }

    const updated = await RideBooking.findOneAndUpdate(
      { _id: booking._id, userId: req.user._id, status: 'payment_pending', paymentStatus: 'pending' },
      { status: 'confirmed', paymentStatus: 'paid', paymentMethod: 'razorpay', paymentReference: paymentId, razorpayPaymentId: paymentId, razorpaySignature: signature },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'Ride booking state changed. Please refresh your bookings.' });

    const ride = await Ride.findById(updated.rideId).select('driverId from to');
    if (ride?.driverId) {
      await notifyUser(ride.driverId, { type: 'payment', title: 'Ride payment received', message: `Payment received for the ${ride.from} to ${ride.to} ride.`, data: { rideBookingId: updated._id.toString() } });
    }

    return res.json({ success: true, message: 'Payment verified. Your seat is confirmed.', booking: { ...updated.toObject(), id: updated._id.toString() } });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Payment verification failed.' });
  }
});

router.post('/bookings/:id/payment-failed', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  const booking = await RideBooking.findOneAndUpdate({ _id: req.params.id, userId: req.user._id, status: 'payment_pending' }, { status: 'cancelled', paymentStatus: 'failed' }, { returnDocument: 'after' });
  if (!booking) return res.status(404).json({ message: 'Ride booking cannot be cancelled.' });
  res.json({ success: true });
});

router.post('/bookings/:id/cancel', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  const booking = await RideBooking.findOne({ _id: req.params.id, userId: req.user._id, status: { $in: ['payment_pending', 'confirmed'] } });
  if (!booking) return res.status(404).json({ message: 'This ride booking cannot be cancelled.' });
  booking.status = 'cancelled';
  await booking.save();
  res.json({ success: true, message: 'Ride booking cancelled.' });
});

router.post('/bookings/:id/feedback', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Ride booking not found.' });
  const booking = await RideBooking.findById(req.params.id).populate('rideId').populate('userId', '_id name');
  if (!booking) return res.status(404).json({ message: 'Ride booking not found.' });
  const riderId = idOf(booking.userId?._id || booking.userId);
  if (riderId !== idOf(req.user._id) && req.user.role !== 'admin') return res.status(403).json({ message: 'You can only rate your own ride booking.' });
  if (!['confirmed', 'completed'].includes(booking.status)) return res.status(400).json({ message: 'Rate a confirmed or completed ride.' });
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: 'Rating must be a whole number from 1 to 5.' });
  booking.rating = rating;
  booking.comment = String(req.body.comment || '').trim().slice(0, 500);
  await booking.save();
  res.json({ success: true, message: 'Feedback submitted successfully.', booking: { ...booking.toObject(), id: booking._id.toString() } });
});

module.exports = router;

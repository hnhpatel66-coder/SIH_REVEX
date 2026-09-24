const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Ride = require('../models/Ride');
const RideBooking = require('../models/RideBooking');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function serializeRide(r) {
  return { ...r, id: r._id.toString(), driverId: r.driverId?.toString() };
}

router.get('/', async (req, res) => {
  try {
    const q = {};
    if (req.query.from) q.from = { $regex: req.query.from.trim(), $options: 'i' };
    if (req.query.to) q.to = { $regex: req.query.to.trim(), $options: 'i' };
    if (req.query.date) {
      const d = new Date(req.query.date);
      if (!Number.isNaN(d.getTime())) {
        const next = new Date(d); next.setDate(next.getDate() + 1);
        q.date = { $gte: d, $lt: next };
      }
    }
    // Public listing shows only approved rides. Admin passes ?status=all.
    if (req.query.status !== 'all') { q.status = 'available'; q.verified = true; }
    const docs = await Ride.find(q).sort({ date: 1, time: 1 }).lean();
    res.json(docs.map(serializeRide));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/bookings/my', requireAuth, async (req, res) => {
  const docs = await RideBooking.find({ userId: req.user._id })
    .populate('rideId')
    .sort({ createdAt: -1 }).lean();
  res.json(docs.map(b => ({
    ...b,
    id: b._id.toString(),
    type: 'ride',
    rideId: b.rideId ? { ...b.rideId, id: b.rideId._id.toString() } : null
  })));
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { from, to, date, time, seats, price, vehicle, vehicleType, numberPlate, driverPhone, vehicleImage } = req.body;
    if (!from || !to || !date || !time || !vehicle || Number(seats) < 1 || Number(price) < 1) {
      return res.status(400).json({ message: 'From, to, date, time, vehicle, seats and price are required.' });
    }
    if (!vehicleType || !['Bike','Scooter','Car','Other'].includes(vehicleType)) {
      return res.status(400).json({ message: 'Vehicle type must be Bike, Scooter, Car or Other.' });
    }
    const tripDate = new Date(date);
    if (Number.isNaN(tripDate.getTime())) return res.status(400).json({ message: 'Invalid ride date.' });
    const today = new Date(); today.setHours(0,0,0,0);
    const day = new Date(tripDate); day.setHours(0,0,0,0);
    if (day < today) return res.status(400).json({ message: 'Ride date cannot be in the past.' });
    if (vehicleImage && typeof vehicleImage === 'string' && vehicleImage.length > 5*1024*1024) {
      return res.status(400).json({ message: 'Vehicle image must be smaller than about 3.5MB.' });
    }

    const r = await Ride.create({
      driverId: req.user._id,
      driver: req.user.name,
      driverPhone: (driverPhone || req.user.phone || '').toString().trim(),
      from: String(from).trim(),
      to: String(to).trim(),
      date: tripDate,
      time: String(time),
      seats: Math.min(6, Number(seats)),
      price: Number(price),
      vehicle: String(vehicle).trim(),
      vehicleType,
      numberPlate: String(numberPlate || '').trim().toUpperCase(),
      vehicleImage: (typeof vehicleImage === 'string' && vehicleImage.startsWith('data:image/')) ? vehicleImage : '',
      verified: req.user.role === 'admin' ? true : false,
      status: req.user.role === 'admin' ? 'available' : 'pending'
    });
    res.status(201).json({...serializeRide(r.toObject()), message: r.status==='pending' ? 'Ride submitted. It will appear after admin approval.' : 'Ride published.'});
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

router.post('/:id/book', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that ride. Please try again.' });

  const seats = Math.max(1, Number(req.body.seats) || 1);
  const ride = await Ride.findById(req.params.id);
  if (!ride) return res.status(404).json({ message: 'We could not find that ride. Please try again.' });
  if (ride.driverId?.toString() === req.user._id.toString()) return res.status(400).json({ message: 'You cannot book your own ride.' });

  const activeBookings = await RideBooking.aggregate([
    { $match: { rideId: ride._id, status: { $in: ['payment_pending', 'confirmed'] } } },
    { $group: { _id: '$rideId', seats: { $sum: '$seats' } } }
  ]);
  const booked = activeBookings[0]?.seats || 0;
  const available = Math.max(0, Number(ride.seats) - booked);
  if (seats > available) return res.status(409).json({ message: `Only ${available} seat(s) are available.` });

  const total = seats * Number(ride.price);
  const b = await RideBooking.create({
    rideId: ride._id,
    userId: req.user._id,
    seats,
    totalAmount: total,
    paymentMethod: 'demo',
    status: 'payment_pending',
    paymentStatus: 'pending'
  });

  res.status(201).json({
    ...b.toObject(),
    id: b._id.toString(),
    payment: { method: 'demo', currency: 'INR', displayAmount: total }
  });
});

router.post('/bookings/:id/payment-demo', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that ride booking. Please try again.' });

  const b = await RideBooking.findOne({
    _id: req.params.id, userId: req.user._id,
    status: 'payment_pending', paymentStatus: 'pending'
  });
  if (!b) return res.status(404).json({ message: 'We could not find that ride booking. Please try again.' });

  const reference = `REVEX-RIDE-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const updated = await RideBooking.findOneAndUpdate(
    { _id: b._id, userId: req.user._id, status: 'payment_pending', paymentStatus: 'pending' },
    { status: 'confirmed', paymentStatus: 'paid', paymentReference: reference },
    { new: true }
  );
  if (!updated) return res.status(409).json({ message: 'Ride booking was already processed.' });

  res.json({ success: true, message: 'Ride payment successful. Seat confirmed.', booking: { ...updated.toObject(), id: updated._id.toString() } });
});

router.post('/bookings/:id/payment-failed', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that ride booking. Please try again.' });
  const b = await RideBooking.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id, status: 'payment_pending' },
    { status: 'cancelled', paymentStatus: 'failed' }, { new: true }
  );
  if (!b) return res.status(404).json({ message: 'We could not find that ride booking. Please try again.' });
  res.json({ success: true });
});

router.post('/bookings/:id/cancel', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that ride booking. Please try again.' });
  const b = await RideBooking.findOne({
    _id: req.params.id, userId: req.user._id,
    status: { $in: ['payment_pending', 'confirmed'] }
  });
  if (!b) return res.status(404).json({ message: 'This ride booking cannot be cancelled.' });
  b.status = 'cancelled';
  await b.save();
  res.json({ success: true, message: 'Ride booking cancelled. Demo payment is not automatically refunded.' });
});

/* Feedback/rating for a ride seat booking. Handles populated and raw ObjectIds. */
router.post('/bookings/:id/feedback', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that ride booking. Please try again.' });

  const b = await RideBooking.findById(req.params.id).populate('rideId').populate('userId','_id name');
  if (!b) return res.status(404).json({ message: 'Ride booking not found.' });

  const riderId = b.userId?._id?.toString() || b.userId?.toString();
  const isRider = riderId === req.user._id.toString();
  if (!isRider && req.user.role !== 'admin') return res.status(403).json({ message: 'Not allowed.' });

  const rating = Number(req.body.rating);
  const comment = String(req.body.comment || '').trim().slice(0,500);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
  }

  b.rating = rating;
  b.comment = comment;
  await b.save();

  res.json({
    success: true,
    message: 'Feedback submitted successfully.',
    booking: { ...b.toObject(), id: b._id.toString() }
  });
});

module.exports = router;

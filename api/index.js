const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const User = require('../backend/models/User');
const Vehicle = require('../backend/models/Vehicle');
const Booking = require('../backend/models/Booking');
const MonthlyBookingCounter = require('../backend/models/MonthlyBookingCounter');
const authRoutes = require('../backend/routes/auth');
const vehicleRoutes = require('../backend/routes/vehicles');
const bookingRoutes = require('../backend/routes/bookings');
const rideRoutes = require('../backend/routes/rides');
const adminRoutes = require('../backend/routes/admin');
const notificationRoutes = require('../backend/routes/notifications');
const chatRoutes = require('../backend/routes/chat');

const { corsOptions, blockPrivateStatic, jsonBodyFallback } = require('../backend/utils/security');
const { connectMongo: connectMongoShared } = require('../backend/utils/db');

const app = express();
app.use(cors(corsOptions()));
const keepRawBody = (req, res, buf) => { if (buf && buf.length) req.rawBody = buf; };
app.use(express.json({ limit: '12mb', verify: keepRawBody }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(blockPrivateStatic);
app.use(jsonBodyFallback());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(path.join(__dirname, '..')));

let cachedDb = null;
let adminReady = null;

async function connectToDatabase() {
  if (cachedDb && mongoose.connection.readyState === 1) return cachedDb;
  const options = { maxPoolSize: 10 };
  // Shared with backend/server.js: guarantees an explicit database name and
  // refuses to silently fall back to a local MongoDB.
  const result = await connectMongoShared();
  cachedDb = mongoose.connection;
  await migrateLegacyData();
  try { await Promise.all([Vehicle.createIndexes(), Booking.createIndexes()]); } catch (error) { console.warn('Index sync deferred:', error.message); }
  console.log(`[mongo] serverless ready. database="${result.database}" mode=${result.mode}`);
  return cachedDb;
}

async function migrateLegacyData() {
  try {
    const vehicles = await Vehicle.find({ $or: [{ category: { $exists: false } }, { status: { $in: ['available', 'unavailable'] } }, { type: { $exists: false } }] }).select('_id status type category fuelType numberPlate numberPlateNormalized verified availability');
    const operations = [];
    const plates = new Set();
    for (const vehicle of vehicles) {
      const update = {};
      if (!vehicle.category) update.category = vehicle.type || 'Other';
      if (!vehicle.type) update.type = vehicle.category || 'Other';
      if (!vehicle.fuelType) update.fuelType = 'Petrol';
      if (vehicle.status === 'available') { update.status = 'approved'; update.verified = vehicle.verified !== false; update.availability = 'available'; }
      if (vehicle.status === 'unavailable') { update.status = 'removed'; update.verified = false; update.availability = 'unavailable'; }
      const plate = String(vehicle.numberPlateNormalized || vehicle.numberPlate || '').replace(/[\s-]+/g, '').toUpperCase();
      if (plate && !vehicle.numberPlateNormalized && !plates.has(plate)) { update.numberPlateNormalized = plate; plates.add(plate); }
      if (Object.keys(update).length) operations.push({ updateOne: { filter: { _id: vehicle._id }, update: { $set: update } } });
    }
    if (operations.length) await Vehicle.bulkWrite(operations);
    const bookingCollection = mongoose.connection.db.collection('bookings');
    const existingIndexes = await bookingCollection.indexes();
    if (existingIndexes.some(index => index.name === 'userId_1_monthKey_1_monthlySlot_1')) await bookingCollection.dropIndex('userId_1_monthKey_1_monthlySlot_1');
    const legacyBookings = await Booking.find({ $or: [{ grandTotal: { $exists: false } }, { subtotal: { $exists: false } }] }).select('_id totalAmount paymentStatus').lean();
    for (const booking of legacyBookings) {
      const amount = Number(booking.totalAmount || 0);
      await Booking.updateOne({ _id: booking._id }, { $set: { grandTotal: amount, subtotal: amount, paidAmount: booking.paymentStatus === 'paid' ? amount : 0, remainingAmount: booking.paymentStatus === 'paid' ? 0 : amount } });
    }
    await Booking.updateMany({ status: { $in: ['cancelled', 'rejected'] }, monthlySlot: { $exists: true } }, { $unset: { monthlySlot: 1 } });
    const activeCounters = await Booking.aggregate([{ $match: { monthKey: { $exists: true }, status: { $in: ['pending', 'payment_pending', 'pending_owner', 'confirmed', 'completed', 'approved'] } } }, { $group: { _id: { userId: '$userId', monthKey: '$monthKey' }, count: { $sum: 1 } } }]);
    for (const counter of activeCounters) await MonthlyBookingCounter.updateOne({ userId: counter._id.userId, monthKey: counter._id.monthKey }, { $set: { count: Math.min(2, counter.count) } }, { upsert: true });
    const counters = await MonthlyBookingCounter.find({}).select('userId monthKey').lean();
    for (const counter of counters) {
      const active = await Booking.countDocuments({ userId: counter.userId, monthKey: counter.monthKey, status: { $in: ['pending', 'payment_pending', 'pending_owner', 'confirmed', 'completed', 'approved'] } });
      if (!active) await MonthlyBookingCounter.deleteOne({ _id: counter._id });
    }
    await reconcileEarningsCounters();
  } catch (error) {
    console.warn('Legacy data migration skipped:', error.message);
  }
}

// Recomputes owner earnings counters from the booking ledger so historical
// cancellations (which previously never decremented) stop inflating totals.
async function reconcileEarningsCounters() {
  const perVehicle = await Booking.aggregate([
    { $match: { paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } } },
    { $group: { _id: '$vehicleId', total: { $sum: { $multiply: [{ $ifNull: ['$grandTotal', '$totalAmount'] }, 0.9] } }, rentals: { $sum: 1 } } }
  ]);
  const known = new Map(perVehicle.map(row => [String(row._id), row]));
  const vehicles = await Vehicle.find({}).select('_id totalEarnings totalRentals').lean();
  for (const vehicle of vehicles) {
    const truth = known.get(String(vehicle._id));
    const totalEarnings = Math.round(truth?.total || 0);
    const totalRentals = truth?.rentals || 0;
    if (vehicle.totalEarnings !== totalEarnings || vehicle.totalRentals !== totalRentals) {
      await Vehicle.updateOne({ _id: vehicle._id }, { $set: { totalEarnings, totalRentals } });
    }
  }
  const perOwner = await Booking.aggregate([
    { $match: { paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } } },
    { $group: { _id: '$ownerId', total: { $sum: { $multiply: [{ $ifNull: ['$grandTotal', '$totalAmount'] }, 0.9] } } } }
  ]);
  const ownerTotals = new Map(perOwner.filter(row => row._id).map(row => [String(row._id), Math.round(row.total || 0)]));
  const owners = await User.find({ role: 'owner' }).select('_id ownerEarnings').lean();
  for (const owner of owners) {
    const total = ownerTotals.get(String(owner._id)) || 0;
    if ((owner.ownerEarnings || 0) !== total) await User.updateOne({ _id: owner._id }, { $set: { ownerEarnings: total } });
  }
}

async function ensureAdmin() {
  if (adminReady) return adminReady;
  adminReady = (async () => {
    const email = String(process.env.ADMIN_EMAIL || 'admin@vroomy.com').trim().toLowerCase();
    const name = process.env.ADMIN_NAME || 'REVEX Admin';
    let admin = await User.findOne({ email });
    if (!admin) {
      const password = process.env.ADMIN_PASSWORD;
      if (!password) { console.warn('No admin exists yet. Set ADMIN_PASSWORD or use /api/auth/setup-admin.'); return { email, id: null }; }
      admin = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 10), role: 'admin', isVerified: true });
      console.log('Admin account created:', admin.email);
    } else {
      console.warn(`Account ${admin.email} exists but is not an admin. Use /api/auth/setup-admin with ADMIN_SETUP_KEY to promote it.`);
      return { email, id: null };
    }
    admin.name = name; await admin.save();
    return { email: admin.email, id: admin._id.toString() };
  })();
  return adminReady;
}

app.use(async (req, res, next) => {
  try {
    // Fail loudly on a missing secret. Without it, token signing throws inside
    // route handlers and every auth attempt surfaces as a confusing 401/500.
    if (!process.env.JWT_SECRET) {
      console.error('[config] JWT_SECRET is MISSING. Set it in the deployment environment variables.');
      return res.status(500).json({ message: 'Server is not configured correctly. Please contact an administrator.' });
    }
    await connectToDatabase();
    await ensureAdmin();
    next();
  } catch (error) {
    console.error('Database connection failed:', error.message);
    if (req.path === '/api/health') return next();
    return res.status(503).json({ message: 'Database connection is unavailable. Please try again shortly.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', databaseName: mongoose.connection.name || null, mode: process.env.ACTIVE_MONGO_MODE || 'unknown', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/*', (req, res) => res.status(404).json({ message: 'API endpoint not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.statusCode || error.status || (error.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ message: status === 413 ? 'Uploaded data is too large. Please compress the file and try again.' : (error.message || 'Unexpected server error.') });
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

module.exports = app;

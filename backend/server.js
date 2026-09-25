const path = require('path');
const dns = require('dns');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const Vehicle = require('./models/Vehicle');
const Booking = require('./models/Booking');
const MonthlyBookingCounter = require('./models/MonthlyBookingCounter');
const authRoutes = require('./routes/auth');
const vehicleRoutes = require('./routes/vehicles');
const bookingRoutes = require('./routes/bookings');
const rideRoutes = require('./routes/rides');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');

try { dns.setServers(['1.1.1.1', '8.8.8.8']); } catch {}
const app = express();
const PORT = Number(process.env.PORT || 5000);
app.use(cors({ origin: process.env.FRONTEND_URL || true, credentials: true }));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use((req, res, next) => {
  if (/^\/(backend|node_modules)(\/|$)|(^|\/)\.env/i.test(req.path)) return res.status(404).end();
  next();
});
app.use(express.static(path.join(__dirname, '..')));

async function migrateLegacyData() {
  const vehicles = await Vehicle.find({ $or: [{ category: { $exists: false } }, { status: { $in: ['available', 'unavailable'] } }] }).select('_id status type category fuelType numberPlate numberPlateNormalized verified availability');
  const operations = [];
  const seenPlates = new Set();
  for (const vehicle of vehicles) {
    const update = {};
    if (!vehicle.category) update.category = vehicle.type || 'Other';
    if (!vehicle.type) update.type = vehicle.category || 'Other';
    if (!vehicle.fuelType) update.fuelType = 'Petrol';
    if (vehicle.status === 'available') { update.status = 'approved'; update.verified = vehicle.verified !== false; update.availability = 'available'; }
    if (vehicle.status === 'unavailable') { update.status = 'removed'; update.verified = false; update.availability = 'unavailable'; }
    const plate = String(vehicle.numberPlateNormalized || vehicle.numberPlate || '').replace(/[\s-]+/g, '').toUpperCase();
    if (plate && !vehicle.numberPlateNormalized && !seenPlates.has(plate)) { update.numberPlateNormalized = plate; seenPlates.add(plate); }
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
}

async function connectMongo() {
  const atlas = process.env.MONGODB_URI;
  const fallback = process.env.MONGODB_FALLBACK_URI || 'mongodb://127.0.0.1:27017/vroomy';
  if (!atlas && !fallback) throw new Error('No MongoDB URI configured.');
  const options = { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 20000, family: 4 };
  if (atlas) {
    try {
      await mongoose.connect(atlas, options); process.env.ACTIVE_MONGO_MODE = 'atlas';
    } catch (error) {
      console.warn('MongoDB Atlas connection failed:', error.message);
      await mongoose.connect(fallback, { ...options, serverSelectionTimeoutMS: 7000 }); process.env.ACTIVE_MONGO_MODE = 'local';
    }
  } else {
    await mongoose.connect(fallback, { ...options, serverSelectionTimeoutMS: 7000 }); process.env.ACTIVE_MONGO_MODE = 'local';
  }
  await migrateLegacyData();
  try { await Promise.all([Vehicle.createIndexes(), Booking.createIndexes()]); } catch (error) { console.warn('Index sync deferred:', error.message); }
}

async function ensureAdmin() {
  const email = String(process.env.ADMIN_EMAIL || 'admin@vroomy.com').trim().toLowerCase();
  const name = process.env.ADMIN_NAME || 'REVEX Admin';
  let admin = await User.findOne({ email });
  if (!admin) {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) { console.warn('No admin exists yet. Set ADMIN_PASSWORD or use the admin setup page.'); return null; }
    admin = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 10), role: 'admin', isVerified: true });
    console.log('Admin account created:', admin.email);
  } else {
    admin.name = name; admin.role = 'admin'; admin.isVerified = true; await admin.save();
  }
  return admin;
}

app.get('/api/health', (req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', databaseName: mongoose.connection.name || null, mode: process.env.ACTIVE_MONGO_MODE || 'unknown' }));
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use((req, res) => res.status(404).json({ message: req.path.startsWith('/api/') ? 'API endpoint not found.' : 'Page not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.statusCode || error.status || (error.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ message: status === 413 ? 'Uploaded data is too large. Please compress the file and try again.' : (error.message || 'Unexpected server error.') });
});

async function start() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is missing. Put JWT_SECRET in backend/.env.');
  await connectMongo();
  await ensureAdmin();
  const server = app.listen(PORT, () => console.log(`REVEX running at http://localhost:${PORT}`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : error.message); process.exit(1); });
}

start().catch(error => { console.error('REVEX could not start:', error.message); process.exit(1); });

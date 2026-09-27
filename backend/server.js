const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const mongoose = require('mongoose');
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
const chatRoutes = require('./routes/chat');
const paymentRoutes = require('./routes/payments');
const { corsMiddleware, blockPrivateStatic, jsonBodyFallback } = require('./utils/security');
const { connectMongo: connectMongoShared } = require('./utils/db');
const gateway = require('./utils/payments');
const gatewayConfig = gateway.publicConfig();
const chatProvider = require('./utils/chatProvider');
const mapbox = require('./utils/mapbox');

const app = express();
// Render / Railway / Fly.io inject PORT automatically. Honour it first so the
// app binds the port the platform routes traffic to. Local default is 5001 to
// match backend/.env.
const PORT = Number(process.env.PORT) || 5001;
// Render/Railway/Fly terminate TLS on a proxy in front of this process, so
// without this req.protocol reports "http" and req.ip is the proxy address.
// Exactly one hop is trusted (that is what Render adds): trusting the whole
// chain would let a client forge X-Forwarded-For and defeat the rate limiter.
app.set('trust proxy', 1);
app.use(corsMiddleware());
const keepRawBody = (req, res, buf) => { if (buf && buf.length) req.rawBody = buf; };
app.use(express.json({ limit: '12mb', verify: keepRawBody }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(blockPrivateStatic);
app.use(jsonBodyFallback());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
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
  const result = await connectMongoShared();
  await migrateLegacyData();
  await reconcileEarningsCounters();
  try { await Promise.all([Vehicle.createIndexes(), Booking.createIndexes()]); } catch (error) { console.warn('Index sync deferred:', error.message); }
}

// Recomputes owner earnings counters from the booking ledger so historical
// cancellations (which previously never decremented) stop inflating totals.
async function reconcileEarningsCounters() {
  try {
    const perVehicle = await Booking.aggregate([
      { $match: { paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } } },
      { $group: { _id: '$vehicleId', total: { $sum: { $multiply: [{ $ifNull: ['$grandTotal', '$totalAmount'] }, 0.9] } }, rentals: { $sum: 1 } } }
    ]);
    const known = new Map(perVehicle.map(row => [String(row._id), row]));
    const vehicles = await Vehicle.find({}).select('_id totalEarnings totalRentals ownerId').lean();
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
  } catch (error) {
    console.warn('Earnings reconciliation skipped:', error.message);
  }
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
  } else if (admin.role !== 'admin') {
    // Never silently promote an existing account on boot. Privileged roles are
    // only granted deliberately through the admin setup endpoint.
    console.warn(`Account ${admin.email} exists but is not an admin. Use admin-setup.html with ADMIN_SETUP_KEY to promote it.`);
    return null;
  } else {
    admin.name = name; await admin.save();
  }
  return admin;
}

/**
 * Reconciles `Ride.seatsBooked` against the live booking ledger on boot.
 *
 * `seatsBooked` is a denormalised counter used for a single guarded atomic
 * update, which is what actually prevents overbooking. Reads always come from
 * the ledger (see `bookedSeatsByRide` in routes/rides.js), so a drifted counter
 * can never show a rider the wrong availability, but it is repaired here anyway
 * so the counter and the ledger agree for reporting.
 */
async function reconcileSeatCounters() {
  const Ride = require('./models/Ride');
  const RideBooking = require('./models/RideBooking');
  const { RIDE_BOOKING_ACTIVE_STATUSES } = require('./utils/statuses');
  try {
    const rows = await RideBooking.aggregate([
      { $match: { status: { $in: RIDE_BOOKING_ACTIVE_STATUSES } } },
      { $group: { _id: '$rideId', seats: { $sum: '$seats' } } }
    ]);
    const expected = new Map(rows.map(row => [String(row._id), row.seats || 0]));
    const rides = await Ride.find({}).select('seats seatsBooked').lean();
    let fixed = 0;
    for (const ride of rides) {
      const want = Math.min(ride.seats || 0, expected.get(String(ride._id)) || 0);
      if ((ride.seatsBooked || 0) !== want) {
        await Ride.updateOne({ _id: ride._id }, { $set: { seatsBooked: Math.max(0, want) } });
        fixed += 1;
      }
    }
    if (fixed) console.log(`[rides] reconciled seatsBooked on ${fixed} ride(s).`);
  } catch (error) {
    console.warn('[rides] seat reconciliation skipped:', error.message);
  }
}

/**
 * The partial unique index that prevents one rider from holding two live seat
 * requests on the same ride cannot be built if the database already contains
 * duplicates. The API blocks new duplicates either way; this only makes the
 * repair path visible instead of failing silently.
 */
async function checkActiveRideBookingIndex() {
  try {
    const RideBooking = require('./models/RideBooking');
    const [indexes, duplicates] = await Promise.all([
      RideBooking.collection.indexes(),
      RideBooking.aggregate([
        { $match: { status: { $in: ['payment_pending', 'pending_owner', 'confirmed'] } } },
        { $group: { _id: { rideId: '$rideId', userId: '$userId' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
        { $count: 'groups' }
      ])
    ]);
    if (indexes.some(index => index.name === 'active_ride_booking_unique')) return;
    if (!duplicates[0]) return;
    console.warn(
      `[rides] The database-level guard "active_ride_booking_unique" could not be created because `
      + `${duplicates[0].groups} duplicate live ride booking pair(s) already exist. The API rejects new duplicates, `
      + 'so no new double-booking is possible. To finish the repair run:  node scripts/fix-duplicate-ride-bookings.js'
    );
  } catch (error) {
    console.warn('[rides] index check skipped:', error.message);
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', databaseName: mongoose.connection.name || null, mode: process.env.ACTIVE_MONGO_MODE || 'unknown' }));

// Runtime configuration handed to the browser.
//
// The frontend cannot tell whether it was served by this Express process (on
// any port, including a platform-assigned one such as Render's) or by a
// separate local dev server. Guessing is what broke registration before, and a
// wrong guess in production points the UI at a port that does not exist there.
// So the server states the answer: when these pages come from us, the API is
// always same-origin.
app.get('/rev-runtime.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.REVEX_API_BASE = ${JSON.stringify('/api')};\nwindow.REVEX_SERVED_BY_API = true;\n`);
});

app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/payments', paymentRoutes);
app.use((req, res) => res.status(404).json({ message: req.path.startsWith('/api/') ? 'API endpoint not found.' : 'Page not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.statusCode || error.status || (error.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ message: status === 413 ? 'Uploaded data is too large. Please compress the file and try again.' : (error.message || 'Unexpected server error.') });
});

/**
 * Safe configuration diagnostics. Reports WHETHER each value is present and
 * sufficient — never the value itself. Secrets must never reach the logs.
 */
function reportConfig() {
  const secret = String(process.env.JWT_SECRET || '');
  const assistant = chatProvider.providerConfig();
  const map = mapbox.describeStatus();
  const lines = [
    `[config] PORT              = ${PORT}`,
    `[config] JWT_SECRET        = ${secret ? `configured (${secret.length} chars)` : 'MISSING'}`,
    `[config] MONGODB_URI       = ${process.env.MONGODB_URI ? 'configured' : 'MISSING'}`,
    `[config] MONGODB_DB_NAME   = ${process.env.MONGODB_DB_NAME || 'vroomy (default)'}`,
    `[config] LOCAL FALLBACK    = ${String(process.env.ALLOW_LOCAL_MONGO_FALLBACK).toLowerCase() === 'true' ? 'ENABLED' : 'disabled'}`,
    `[config] ADMIN_EMAIL       = ${process.env.ADMIN_EMAIL || 'not set'}`,
    `[config] SMTP (password reset) = ${process.env.SMTP_HOST ? 'configured' : 'not configured (demo reset only)'}`,
    // "Keys are present" is NOT "Razorpay works". The line deliberately says
    // `present`, and the live result is printed by reportGatewayHealth() below.
    // Claiming "connected" here is what hid a rejected key pair for so long.
    `[config] Razorpay          = ${gatewayConfig.enabled ? `keys present (${process.env.RAZORPAY_KEY_ID}), verifying…` : 'NOT configured (payments use a labelled test payment)'}`,
    `[config] PLATFORM_FEE      = ${process.env.PLATFORM_FEE_PERCENT || '10'}%`,
    `[config] Cancellation      = free for ${process.env.CANCEL_FREE_WINDOW_HOURS ?? '6'}h before start, then the per-actor fee in backend/.env`,
    `[config] REVEX Assistant   = ${assistant.configured
      ? `configured (${assistant.model}${assistant.derivedUrl ? ', endpoint derived from the key' : ''})`
      : `NOT configured — ${assistant.problem}`}`,
    // Never the token itself, only its kind and what it can actually do. The
    // route line is deliberately explicit about which of the three road-data
    // tiers is live, so nobody has to guess why a route looks approximate.
    `[config] Mapbox token      = ${map.tokenKind === 'none' ? 'NOT set' : `configured (${map.tokenKind}.…)`}`,
    `[config] Mapbox GL JS map  = ${map.mapReady ? 'ENABLED in the browser' : 'not configured — the built-in route map is used'}`,
    `[config] Smart Route roads = ${map.roadDataSource}${map.problem ? ` — ${map.problem}` : ''}`,
    `[config] Smart Route match = within ${map.toleranceKm} km of a ride's road`
  ];
  if (secret && secret.length < 32) lines.push('[config] WARNING: JWT_SECRET is shorter than 32 characters.');
  lines.forEach(line => console.log(line));
}

/**
 * Asks Razorpay whether it actually accepts the keys, and says so plainly.
 * A revoked or mistyped key pair passes every "is it set?" test, so without
 * this the only symptom is a payment that fails at checkout.
 */
async function reportGatewayHealth() {
  if (!gatewayConfig.enabled) return;
  const health = await gateway.checkHealth({ force: true });
  if (health.usable) {
    console.log('[gateway] Razorpay accepted the API keys. Real payments are enabled.');
    return;
  }
  console.error(`[gateway] Razorpay is NOT usable (${health.state}).`);
  console.error(`[gateway]   ${health.message}`);
  console.error('[gateway]   Until this is fixed, payments use a labelled test payment and no real money moves.');
}

async function start() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is missing. Put JWT_SECRET in backend/.env.');
  reportConfig();
  await connectMongo();
  await ensureAdmin();
  await reconcileSeatCounters();
  await checkActiveRideBookingIndex();
  const server = app.listen(PORT, () => console.log(`REVEX running at http://localhost:${PORT}`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : error.message); process.exit(1); });
  // After listening, so a slow or unreachable gateway never delays startup.
  reportGatewayHealth().catch(error => console.error('[gateway] health check failed:', error.message));
}

start().catch(error => { console.error('REVEX could not start:', error.message); process.exit(1); });

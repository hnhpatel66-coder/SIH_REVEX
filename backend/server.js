const path = require('path');
const dns = require('dns');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const User = require('./models/User');
const authRoutes = require('./routes/auth');
const vehicleRoutes = require('./routes/vehicles');
const bookingRoutes = require('./routes/bookings');
const rideRoutes = require('./routes/rides');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = Number(process.env.PORT || 5000);

// Atlas SRV lookup can fail on some Windows/ISP DNS configurations.
// Prefer public DNS resolvers for SRV lookups when possible.
try { dns.setServers(['1.1.1.1', '8.8.8.8']); } catch {}

app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    databaseName: mongoose.connection.name || null,
    mode: process.env.ACTIVE_MONGO_MODE || 'unknown'
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/admin', adminRoutes);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'Request not found.' });
  res.status(404).json({ message: 'Page not found.' });
});

async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@vroomy.com').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'Admin@12345';
  const name = process.env.ADMIN_NAME || 'REVEX Admin';

  let admin = await User.findOne({ email });
  const passwordHash = await bcrypt.hash(password, 10);

  // Make the known demo/admin account deterministic for hackathon testing.
  // Existing users/vehicles/bookings are not deleted.
  if (admin) {
    admin.name = name;
    admin.role = 'admin';
    admin.isVerified = true;
    admin.passwordHash = passwordHash;
    await admin.save();
  } else {
    admin = await User.create({
      name, email, passwordHash,
      role: 'admin', isVerified: true
    });
  }
  return { email: admin.email, id: admin._id.toString() };
}

async function connectMongo() {
  const atlas = process.env.MONGODB_URI;
  const fallback = process.env.MONGODB_FALLBACK_URI || 'mongodb://127.0.0.1:27017/vroomy';

  if (!atlas && !fallback) throw new Error('No MongoDB URI configured.');

  if (atlas) {
    try {
      await mongoose.connect(atlas, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 20000,
        family: 4
      });
      process.env.ACTIVE_MONGO_MODE = 'atlas';
      console.log('MongoDB connected (Atlas):', mongoose.connection.name);
      return;
    } catch (err) {
      console.warn('MongoDB Atlas connection failed:', err.message);
      console.warn('Trying local MongoDB fallback:', fallback);
      try { await mongoose.disconnect(); } catch {}
    }
  }

  await mongoose.connect(fallback, {
    serverSelectionTimeoutMS: 7000,
    connectTimeoutMS: 7000,
    family: 4
  });
  process.env.ACTIVE_MONGO_MODE = 'local';
  console.log('MongoDB connected (local):', mongoose.connection.name);
}

async function start() {
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET is missing. Put JWT_SECRET in backend/.env.');
    process.exit(1);
  }

  try {
    await connectMongo();
    const admin = await ensureAdmin();
    console.log('Admin ready:', admin.email);
  } catch (err) {
    console.error('MongoDB connection failed.');
    console.error(err.message);
    console.error('Start MongoDB locally or fix the Atlas MONGODB_URI/network DNS.');
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`REVEX running at http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/api/health`);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use.`);
    else console.error('Server error:', err.message);
    process.exit(1);
  });
}

start();

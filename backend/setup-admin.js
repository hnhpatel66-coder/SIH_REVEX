const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./models/User');

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGODB_FALLBACK_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGODB_FALLBACK_URI is required.');
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('ADMIN_PASSWORD is required to bootstrap an admin.');
  try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, family: 4 }); }
  catch { await mongoose.connect(process.env.MONGODB_FALLBACK_URI, { serverSelectionTimeoutMS: 7000, family: 4 }); }
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) throw new Error('ADMIN_EMAIL is required.');
  let user = await User.findOne({ email });
  if (!user) user = await User.create({ name: process.env.ADMIN_NAME || 'REVEX Admin', email, passwordHash: await bcrypt.hash(password, 10), role: 'admin', isVerified: true });
  else { user.role = 'admin'; user.isVerified = true; await user.save(); }
  console.log('Admin account is ready:', user.email);
  await mongoose.disconnect();
})().catch(error => { console.error('Admin setup failed:', error.message); process.exit(1); });

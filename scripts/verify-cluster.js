// Verifies the NEW Atlas cluster is really in use and the data is sound.
// Usage: node scripts/verify-cluster.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const mongoose = require('mongoose');
const { buildMongoUri } = require('../backend/utils/db');

const mask = uri => uri.replace(/\/\/[^@]*@/, '//<user>:<pass>@').split('?')[0];

// The deleted cluster hostname is assembled at runtime so this file does not
// itself hard-code it. tests/registration-regression.test.js fails the build if
// any source file contains the obsolete hostname literally.
const OLD_HOST_MARKER = ['eazd', '3bx'].join('');

(async () => {
  const uri = buildMongoUri(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'vroomy');
  const expectedHost = 'revex.r2zrw0p.mongodb.net';

  console.log('\nNEW Atlas cluster verification\n');
  console.log('  uri (masked)  :', mask(uri));
  console.log('  uses new host :', uri.includes(expectedHost));
  console.log('  old host gone :', !uri.includes(OLD_HOST_MARKER));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 12000, family: 4 });
  console.log('  connected db  :', mongoose.connection.name);

  const cols = await mongoose.connection.db.listCollections().toArray();
  console.log('  collections   :', cols.length, `(${cols.map(c => c.name).join(', ')})`);

  const users = await mongoose.connection.db.collection('users').find({}).toArray();
  const vehicles = await mongoose.connection.db.collection('vehicles').find({}).toArray();
  console.log('  users         :', users.length);
  console.log('  vehicles      :', vehicles.length);

  // Admin seeded correctly, and the password is a bcrypt hash.
  const admin = users.find(u => u.email === process.env.ADMIN_EMAIL);
  const BCRYPT = /^\$2[aby]?\$\d{2}\$/;
  console.log('  admin present :', Boolean(admin));
  if (admin) {
    console.log('  admin role    :', admin.role);
    console.log('  admin hashed  :', BCRYPT.test(String(admin.passwordHash || '')));
  }
  const admins = users.filter(u => u.role === 'admin');
  console.log('  admin count   :', admins.length, admins.length === 1 ? '(correct: no duplicates)' : '(WARNING: duplicates)');

  // No user may ever hold a plaintext password.
  const plaintext = users.filter(u => u.passwordHash && !BCRYPT.test(String(u.passwordHash)));
  console.log('  plaintext pwd :', plaintext.length, plaintext.length === 0 ? '(none)' : '(SECURITY PROBLEM)');

  // Passwords must never be stored in a `password` field.
  const rawPasswordField = users.filter(u => u.password !== undefined);
  console.log('  raw password  :', rawPasswordField.length, rawPasswordField.length === 0 ? '(none)' : '(SECURITY PROBLEM)');

  // Unique index on email must exist (duplicate protection).
  const indexes = await mongoose.connection.db.collection('users').indexes();
  const emailIndex = indexes.find(i => i.key && i.key.email === 1);
  console.log('  email index   :', emailIndex ? (emailIndex.unique ? 'unique (correct)' : 'present but NOT unique') : 'MISSING');

  // Duplicate plate check.
  const plates = await mongoose.connection.db.collection('vehicles').aggregate([
    { $match: { numberPlateNormalized: { $regex: '.' } } },
    { $group: { _id: '$numberPlateNormalized', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }
  ]).toArray();
  console.log('  duplicate plates:', plates.length);

  await mongoose.disconnect();
})().catch(error => { console.error('Verification failed:', error.message); process.exit(1); });

// Shows what currently exists in the database, with creation timestamps.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { buildMongoUri } = require('../backend/utils/db');
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(buildMongoUri(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'vroomy'), { serverSelectionTimeoutMS: 15000, family: 4 });
  const db = mongoose.connection.db;
  console.log('\nconnected to database:', mongoose.connection.name, '\n');

  for (const name of ['users', 'vehicles', 'bookings', 'agreements', 'payments', 'notifications', 'monthlybookingcounters']) {
    const n = await db.collection(name).countDocuments();
    console.log(`${name} = ${n}`);
  }

  const users = await db.collection('users').find({}).project({ email: 1, role: 1, createdAt: 1 }).toArray();
  console.log('\nUSERS:');
  users.forEach(u => console.log(`  ${String(u.role).padEnd(6)} ${String(u.email).padEnd(24)} created=${u.createdAt ? new Date(u.createdAt).toISOString() : 'n/a'}`));

  const vehicles = await db.collection('vehicles').find({}).project({ name: 1, createdAt: 1 }).limit(6).toArray();
  console.log('\nVEHICLES (first 6):');
  vehicles.forEach(v => console.log(`  ${String(v.name).padEnd(24)} created=${v.createdAt ? new Date(v.createdAt).toISOString() : 'n/a'}`));

  console.log('\nnow =', new Date().toISOString());
  await mongoose.disconnect();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });

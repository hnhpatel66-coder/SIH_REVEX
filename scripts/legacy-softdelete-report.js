// Reports legacy soft-delete records left over from before hard delete.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { buildMongoUri } = require('../backend/utils/db');
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(buildMongoUri(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'vroomy'), { serverSelectionTimeoutMS: 12000, family: 4 });
  const db = mongoose.connection.db;

  const byStatus = await db.collection('vehicles').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
  console.log('vehicle statuses      :', JSON.stringify(byStatus.reduce((a, r) => ({ ...a, [r._id || 'none']: r.n }), {})));

  const removed = await db.collection('vehicles').countDocuments({ status: 'removed' });
  const inactiveUsers = await db.collection('users').countDocuments({ isActive: { $ne: true } });
  const deactivated = await db.collection('users').countDocuments({ deactivatedAt: { $exists: true } });
  console.log('legacy removed vehicles:', removed);
  console.log('users isActive != true  :', inactiveUsers);
  console.log('users with deactivatedAt:', deactivated);

  if (removed) {
    console.log('\nThese predate hard delete. Remove them with:');
    console.log('  node scripts/purge-legacy.js --apply');
  } else {
    console.log('\nNo legacy soft-delete records remain.');
  }
  await mongoose.disconnect();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });

// Database integrity audit. Run with: node scripts/db-audit.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const mongoose = require('mongoose');
const { buildMongoUri } = require('../backend/utils/db');

(async () => {
  // Must go through buildMongoUri. Connecting to the raw MONGODB_URI silently
  // targets the Atlas default "test" database whenever the URI omits a database
  // name, so this script previously audited the wrong database entirely.
  const dbName = process.env.MONGODB_DB_NAME || 'vroomy';
  try { await mongoose.connect(buildMongoUri(process.env.MONGODB_URI, dbName), { serverSelectionTimeoutMS: 15000, family: 4 }); }
  catch { await mongoose.connect(buildMongoUri(process.env.MONGODB_FALLBACK_URI, dbName), { serverSelectionTimeoutMS: 8000, family: 4 }); }

  const coll = name => mongoose.connection.db.collection(name);
  const problems = [];

  const dupPlates = await coll('vehicles').aggregate([
    { $match: { numberPlateNormalized: { $regex: '.' } } },
    { $group: { _id: '$numberPlateNormalized', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }
  ]).toArray();
  if (dupPlates.length) problems.push(`duplicate number plates: ${dupPlates.map(d => d._id).join(', ')}`);

  const bookings = await coll('bookings').find({}).toArray();
  const bookingIds = new Set(bookings.map(b => String(b._id)));
  const agreements = await coll('agreements').find({}).toArray();
  const orphans = agreements.filter(a => !bookingIds.has(String(a.bookingId)));
  if (orphans.length) problems.push(`orphan agreements (no booking): ${orphans.length}`);

  const vehicles = await coll('vehicles').find({}).toArray();
  const vehicleIds = new Set(vehicles.map(v => String(v._id)));
  const brokenVehicleRefs = bookings.filter(b => b.vehicleId && !vehicleIds.has(String(b.vehicleId)));
  if (brokenVehicleRefs.length) problems.push(`bookings pointing at missing vehicles: ${brokenVehicleRefs.length}`);

  const badTotals = bookings.filter(b => b.totalAmount != null && b.grandTotal != null && Number(b.totalAmount) !== Number(b.grandTotal));
  if (badTotals.length) problems.push(`bookings where totalAmount != grandTotal: ${badTotals.length}`);

  const negative = bookings.filter(b => Number(b.remainingAmount || 0) < 0);
  if (negative.length) problems.push(`bookings with negative remaining amount: ${negative.length}`);

  const paidCancelled = bookings.filter(b => b.status === 'cancelled' && b.paymentStatus === 'paid');
  // Informational, not a defect: the app explicitly states that refunds are
  // handled outside the payment provider. Owner earnings are already reversed
  // by applyEarningsDelta(-1) when a confirmed paid booking is cancelled.

  const byStatus = {};
  for (const b of bookings) byStatus[b.status || 'none'] = (byStatus[b.status || 'none'] || 0) + 1;

  console.log('Database integrity audit');
  console.log('  database              :', mongoose.connection.name, `(${process.env.ACTIVE_MONGO_MODE || 'n/a'})`);
  console.log('  vehicles              :', vehicles.length);
  console.log('  bookings              :', bookings.length);
  console.log('  agreements            :', agreements.length);
  console.log('  booking statuses      :', JSON.stringify(byStatus));
  console.log('  duplicate plates      :', dupPlates.length);
  console.log('  orphan agreements     :', orphans.length);
  console.log('  broken vehicle refs   :', brokenVehicleRefs.length);
  console.log('  total mismatches      :', badTotals.length);
  console.log('  negative remaining    :', negative.length);
  console.log('  cancelled-but-paid    :', paidCancelled.length, '(refund handled off-platform; earnings reversed)');

  if (problems.length) {
    console.log('\nISSUES FOUND:');
    for (const p of problems) console.log('  -', p);
  } else {
    console.log('\nNo integrity problems detected.');
  }
  await mongoose.disconnect();
  process.exit(problems.length ? 1 : 0);
})().catch(error => { console.error('Audit failed:', error.message); process.exit(1); });

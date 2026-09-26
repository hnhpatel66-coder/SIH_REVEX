/**
 * Purge leftovers from the OLD soft-delete behaviour.
 *
 * Before hard delete, vehicles were only "deregistered" (status = 'removed')
 * and accounts were only "deactivated" (isActive = false). Those rows stayed in
 * MongoDB forever and still appeared in admin lists. This script cleans them up:
 *
 *   1. Legacy `status: 'removed'` vehicles are permanently deleted using the
 *      same cascade as the admin Delete button (bookings, agreements,
 *      payments, reviews and notifications go with them).
 *   2. Accounts that carry a stale `deactivatedAt` marker while `isActive` is
 *      true simply have that marker cleared. NO account is ever deleted here --
 *      account deletion stays an explicit, confirmed action in the admin UI.
 *
 * Safety: dry run by default. Pass --apply to execute.
 *   node scripts/purge-legacy.js            # list only
 *   node scripts/purge-legacy.js --apply    # execute
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { buildMongoUri } = require('../backend/utils/db');
const { deleteVehicleCascade } = require('../backend/utils/hardDelete');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const BATCH = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || 200);

(async () => {
  await mongoose.connect(buildMongoUri(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'vroomy'), { serverSelectionTimeoutMS: 12000, family: 4 });
  const db = mongoose.connection.db;

  const removedVehicles = await db.collection('vehicles')
    .find({ status: 'removed' })
    .project({ name: 1, numberPlate: 1, ownerId: 1 })
    .limit(BATCH)
    .toArray();

  const staleMarkers = await db.collection('users')
    .find({ deactivatedAt: { $exists: true }, isActive: { $ne: false } })
    .project({ email: 1, role: 1, isActive: 1 })
    .toArray();

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — legacy soft-delete cleanup\n`);
  console.log(`  removed vehicles to permanently delete : ${removedVehicles.length}`);
  console.log(`  accounts with a stale marker to clear  : ${staleMarkers.length} (no account is deleted)\n`);

  if (removedVehicles.length) {
    console.log('  Vehicles that will be removed:');
    removedVehicles.forEach(v => console.log(`    - ${v.name || '(unnamed)'}  [${v.numberPlate || 'no plate'}]`));
  }
  if (staleMarkers.length) {
    console.log('\n  Accounts whose stale marker will be cleared:');
    staleMarkers.slice(0, 10).forEach(u => console.log(`    - ${u.email} (${u.role})`));
    if (staleMarkers.length > 10) console.log(`    ... and ${staleMarkers.length - 10} more`);
  }

  if (!APPLY) {
    console.log('\n  Re-run with --apply to execute.\n');
    await mongoose.disconnect();
    return;
  }

  let removed = 0;
  const totals = {};
  for (const vehicle of removedVehicles) {
    const result = await deleteVehicleCascade(vehicle._id);
    if (result.deleted) {
      removed++;
      for (const [key, value] of Object.entries(result.counts || {})) {
        totals[key] = (totals[key] || 0) + value;
      }
    }
  }
  console.log(`\n  Vehicles permanently deleted: ${removed}`);

  const markerResult = await db.collection('users')
    .updateMany({ deactivatedAt: { $exists: true }, isActive: { $ne: false } }, { $unset: { deactivatedAt: '' } });
  console.log(`  Stale markers cleared      : ${markerResult.modifiedCount}`);

  const cascade = Object.entries(totals).map(([k, v]) => `${v} ${k}`).join(', ');
  if (cascade) console.log(`  Cascade removed            : ${cascade}`);

  const left = await db.collection('vehicles').countDocuments({ status: 'removed' });
  console.log(`\n  Remaining 'removed' vehicles: ${left}`);
  await mongoose.disconnect();
})().catch(e => { console.error('Purge failed:', e.message); process.exit(1); });

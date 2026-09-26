#!/usr/bin/env node
/**
 * CLEAN UP TEST DATA  (scripts/cleanup-probe-data.js)
 *
 * Removes everything the diagnostics and the end-to-end suite created, and
 * NOTHING that the owner made by hand.
 *
 * The rule is simple and mechanical: find the accounts those tools register
 * (every one uses a throwaway domain), then delete every row that belongs to
 * those accounts. An account's vehicle, ride, bookings, payments, notifications,
 * chat history and monthly counters are all reachable from its user id, so the
 * whole set goes together and the owner's own rows are never candidates.
 *
 * Two extra cases:
 *   - the rental probes created a vehicle as the ADMIN, so that one is matched by
 *     its number plate rather than by owner;
 *   - monthly counters whose user no longer exists are orphans from an earlier
 *     run and are swept up.
 *
 *   node scripts/cleanup-probe-data.js
 *   node scripts/cleanup-probe-data.js --dry-run
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', 'backend', '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim();
}

/**
 * Every account these tools create uses a throwaway domain, so matching the
 * domain is enough. An earlier version matched a list of name prefixes and
 * missed one account, leaving an orphan booking behind.
 */
const PROBE_EMAIL = /@revex\.test$/i;
/** tests/api-flow.test.js registers rider/owner/rider2/rider3 at <run>@example.test. */
const E2E_EMAIL = /^[\w.+-]+@example\.test$/;

/** The vehicle the rental probe created as the admin. */
const PROBE_PLATES = ['GJ01AB1234'];

/** collection -> the field that ties a row back to the account that made it. */
const OWNED_BY_USER = {
  vehicles: 'ownerId',
  rides: 'driverId',
  bookings: 'userId',
  ridebookings: 'userId',
  payments: 'userId',
  notifications: 'userId',
  chatconversations: 'userId',
  monthlybookingcounters: 'userId',
  reviews: 'userId',
  agreements: 'renterId'
};

(async () => {
  const DRY = process.argv.includes('--dry-run');
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME || 'vroomy' });
  const db = mongoose.connection.db;
  const collections = new Set((await db.listCollections().toArray()).map(c => c.name));

  const before = {};
  for (const name of collections) before[name] = await db.collection(name).countDocuments();
  console.log('before:', JSON.stringify(before));
  console.log('');

  const testUsers = await db.collection('users').find({ $or: [{ email: PROBE_EMAIL }, { email: E2E_EMAIL }] }).toArray();
  const testIds = testUsers.map(row => row._id);
  const testEmails = testUsers.map(row => row.email);
  console.log(`throwaway accounts: ${testUsers.length}${testEmails.length ? ` (${testEmails.join(', ')})` : ''}`);

  // Rows a tool created that no longer point at a live account.
  const liveIds = new Set((await db.collection('users').find({}, { projection: { _id: 1 } }).toArray()).map(row => String(row._id)));
  const orphans = {};
  for (const [name, field] of Object.entries(OWNED_BY_USER)) {
    if (!collections.has(name)) continue;
    const rows = await db.collection(name).find({}, { projection: { [field]: 1 } }).toArray();
    const dangling = rows.filter(row => row[field] && !liveIds.has(String(row[field]))).map(row => row._id);
    if (dangling.length) orphans[name] = dangling;
  }

  if (DRY) {
    console.log('would delete:');
    for (const [name, field] of Object.entries(OWNED_BY_USER)) {
      if (!collections.has(name) || !testIds.length) continue;
      const count = await db.collection(name).countDocuments({ [field]: { $in: testIds } });
      if (count) console.log(`  ${name.padEnd(24)} ${count}`);
    }
    console.log('  (dry run - nothing changed)');
    await mongoose.disconnect();
    return;
  }

  const removed = {};
  if (testIds.length) {
    for (const [name, field] of Object.entries(OWNED_BY_USER)) {
      if (!collections.has(name)) continue;
      const result = await db.collection(name).deleteMany({ [field]: { $in: testIds } });
      if (result.deletedCount) removed[name] = result.deletedCount;
    }
    // Agreements also record the renter's email, which survives the user delete.
    if (collections.has('agreements') && testEmails.length) {
      const result = await db.collection('agreements').deleteMany({ renterEmail: { $in: testEmails } });
      if (result.deletedCount) removed.agreements = (removed.agreements || 0) + result.deletedCount;
    }
    removed.users = (await db.collection('users').deleteMany({ _id: { $in: testIds } })).deletedCount;
  }

  // The rental probe's vehicle was created by the admin, so match it by plate.
  if (collections.has('vehicles')) {
    const result = await db.collection('vehicles').deleteMany({ numberPlate: { $in: PROBE_PLATES } });
    if (result.deletedCount) removed.vehicles = (removed.vehicles || 0) + result.deletedCount;
  }
  // Sweep up rows orphaned by an earlier run.
  for (const [name, ids] of Object.entries(orphans)) {
    const result = await db.collection(name).deleteMany({ _id: { $in: ids } });
    if (result.deletedCount) removed[name] = (removed[name] || 0) + result.deletedCount;
  }

  console.log('');
  console.log('deleted:', JSON.stringify(removed));

  const after = {};
  for (const c of await db.listCollections().toArray()) after[c.name] = await db.collection(c.name).countDocuments();
  console.log('after :', JSON.stringify(after));
  console.log('');
  const remaining = await db.collection('users').find({}, { projection: { email: 1, role: 1, _id: 0 } }).sort({ role: 1 }).toArray();
  console.log(`accounts left (${remaining.length}):`);
  remaining.forEach(u => console.log('   ', String(u.role).padEnd(6), u.email));

  await mongoose.disconnect();
})().catch(error => {
  console.error('cleanup failed:', error.message);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});

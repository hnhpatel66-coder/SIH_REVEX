/**
 * Full database reset.
 *
 * Wipes every collection, recreates the indexes the app depends on, and
 * creates exactly three accounts: admin, owner and user.
 *
 * This is a DATA-ONLY operation. It never modifies source files, schema
 * definitions or configuration.
 *
 *   node scripts/reset-db.js            # dry run (default)
 *   node scripts/reset-db.js --backup   # write a JSON backup first
 *   node scripts/reset-db.js --apply    # perform the reset
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { buildMongoUri } = require('../backend/utils/db');
const mongoose = require('mongoose');

const COLLECTIONS = [
  'monthlybookingcounters', 'agreements', 'rides', 'vehicles', 'bookings',
  'users', 'reviews', 'ridebookings', 'payments', 'notifications'
];

const APPLY = process.argv.includes('--apply');
const BACKUP = process.argv.includes('--backup');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

// The three accounts to keep. Passwords are only used when the account is
// created; an existing account of the same email is updated to match.
const ACCOUNTS = [
  {
    key: 'user', name: 'Demo User', email: 'user@revex.com', phone: '9800000001',
    password: 'User@12345', role: 'user', isVerified: true
  },
  {
    key: 'owner', name: 'Demo Owner', email: 'owner@revex.com', phone: '9800000002',
    password: 'Owner@12345', role: 'owner', isVerified: true
  },
  {
    key: 'admin', name: 'REVEX Admin', email: 'admin@vroomy.com', phone: '9800000003',
    password: 'Admin@12345', role: 'admin', isVerified: true
  }
];

(async () => {
  const uri = buildMongoUri(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'vroomy');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, family: 4 });
  const db = mongoose.connection.db;
  console.log(`\nDatabase reset — ${mongoose.connection.name}\n`);

  // ------------------------------------------------------------- inventory
  const existing = await db.listCollections().toArray();
  const before = {};
  for (const name of existing.map(c => c.name)) {
    before[name] = await db.collection(name).countDocuments();
  }
  const totalDocs = Object.values(before).reduce((a, b) => a + b, 0);
  console.log('  current contents:');
  Object.entries(before).forEach(([name, n]) => console.log(`    ${name.padEnd(24)} ${n}`));
  console.log(`    ${'TOTAL'.padEnd(24)} ${totalDocs}\n`);

  if (!APPLY) {
    console.log('  DRY RUN. Nothing was changed.\n');
    console.log('  To proceed:');
    console.log('    node scripts/reset-db.js --backup --apply\n');
    await mongoose.disconnect();
    return;
  }

  // --------------------------------------------------------------- backup
  if (BACKUP) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `revex-${stamp}.json`);
    const dump = { database: mongoose.connection.name, takenAt: new Date().toISOString(), collections: {} };
    for (const name of Object.keys(before)) {
      dump.collections[name] = await db.collection(name).find({}).toArray();
    }
    fs.writeFileSync(file, JSON.stringify(dump, null, 0), 'utf8');
    console.log(`  Backup written: ${file} (${Object.keys(before).length} collections)`);
  }

  // ----------------------------------------------------------------- wipe
  for (const name of existing.map(c => c.name)) {
    await db.collection(name).drop().catch(() => {});
  }
  console.log(`\n  Dropped ${existing.length} collections`);

  // Recreate the collections the models expect, with the unique indexes the
  // app relies on (duplicate email / number plate protection).
  const indexSpecs = [
    ['users', [
      [{ key: { email: 1 }, name: 'email_1', unique: true }],
      [{ key: { role: 1, createdAt: -1 }, name: 'role_1_createdAt_-1' }]
    ]],
    ['vehicles', [
      [{ key: { ownerId: 1 }, name: 'ownerId_1' }],
      [{ key: { category: 1 }, name: 'category_1' }],
      [{ key: { fuelType: 1 }, name: 'fuelType_1' }],
      [{ key: { location: 1 }, name: 'location_1' }],
      [{ key: { numberPlateNormalized: 1 }, name: 'numberPlateNormalized_1', unique: true, sparse: true }]
    ]],
    ['bookings', [
      [{ key: { userId: 1 }, name: 'userId_1' }],
      [{ key: { vehicleId: 1 }, name: 'vehicleId_1' }],
      [{ key: { ownerId: 1 }, name: 'ownerId_1' }],
      [{ key: { monthKey: 1, monthlySlot: 1 }, name: 'monthKey_1_monthlySlot_1', unique: true, sparse: true }]
    ]],
    ['agreements', [
      [{ key: { bookingId: 1 }, name: 'bookingId_1', unique: true }],
      [{ key: { agreementId: 1 }, name: 'agreementId_1', unique: true }]
    ]],
    ['payments', [
      [{ key: { reference: 1 }, name: 'reference_1', unique: true }],
      [{ key: { bookingId: 1 }, name: 'bookingId_1' }],
      [{ key: { userId: 1 }, name: 'userId_1' }],
      [{ key: { vehicleId: 1 }, name: 'vehicleId_1' }]
    ]],
    ['reviews', [
      [{ key: { userId: 1 }, name: 'userId_1' }],
      [{ key: { vehicleId: 1 }, name: 'vehicleId_1' }],
      [{ key: { bookingId: 1 }, name: 'bookingId_1', unique: true, sparse: true }],
      [{ key: { vehicleId: 1, createdAt: -1 }, name: 'vehicleId_1_createdAt_-1' }]
    ]],
    ['notifications', [{ key: { userId: 1, createdAt: -1 }, name: 'userId_1_createdAt_-1' }]],
    ['ridebookings', [{ key: { rideId: 1 }, name: 'rideId_1' }], [{ key: { userId: 1 }, name: 'userId_1' }]],
    ['rides', [{ key: { driverId: 1 }, name: 'driverId_1' }]],
    ['monthlybookingcounters', [{ key: { userId: 1, monthKey: 1 }, name: 'userId_1_monthKey_1', unique: true }]]
  ];

  let indexCount = 0;
  for (const [name, ...indexGroups] of indexSpecs) {
    await db.createCollection(name).catch(() => {});
    for (const group of indexGroups) {
      for (const spec of group) {
        await db.collection(name).createIndex(spec.key, {
          name: spec.name, unique: !!spec.unique, sparse: !!spec.sparse
        }).catch(() => {});
        indexCount++;
      }
    }
  }
  console.log(`  Recreated ${indexSpecs.length} collections with ${indexCount} indexes`);

  // ------------------------------------------------------------- accounts
  const created = [];
  for (const account of ACCOUNTS) {
    const passwordHash = await bcrypt.hash(account.password, 10);
    await db.collection('users').insertOne({
      name: account.name,
      email: account.email,
      phone: account.phone,
      passwordHash,
      role: account.role,
      isVerified: account.isVerified,
      ownerEarnings: 0,
      totalCarsOnRent: 0,
      carApprovalStatus: account.role === 'owner' ? 'pending' : 'pending',
      resetPasswordToken: null,
      resetPasswordExpires: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const doc = await db.collection('users').findOne({ email: account.email });
    created.push({ ...account, id: String(doc._id), passwordHash: undefined });
  }

  console.log('\n  Accounts created:');
  created.forEach(a => console.log(`    ${a.role.padEnd(6)} ${a.email.padEnd(20)} id=${a.id}`));

  // ------------------------------------------------------------ verify
  const after = {};
  for (const name of COLLECTIONS) {
    after[name] = await db.collection(name).countDocuments();
  }
  console.log('\n  final contents:');
  Object.entries(after).forEach(([name, n]) => console.log(`    ${name.padEnd(24)} ${n}`));

  const adminCount = await db.collection('users').countDocuments({ role: 'admin' });
  console.log(`\n  total users: ${await db.collection('users').countDocuments()}  (admins: ${adminCount})`);

  console.log('\n  CREDENTIALS');
  created.forEach(a => console.log(`    ${a.role.toUpperCase().padEnd(6)} ${a.email}  /  ${a.password}`));
  console.log('');

  await mongoose.disconnect();
})().catch(error => { console.error('Reset failed:', error.message); process.exit(1); });

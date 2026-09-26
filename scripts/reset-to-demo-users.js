#!/usr/bin/env node
/**
 * RESET TO EXACTLY THREE ACCOUNTS  (scripts/reset-to-demo-users.js)
 * ============================================================================
 * THE DESTRUCTIVE ONE. Read this before running it.
 *
 * WHAT IT DOES
 *
 *   1. DROPS every collection in the database except `users`.
 *      That means all vehicles, rides, bookings, payments, agreements, reviews,
 *      notifications and chat conversations are DELETED, not archived.
 *   2. DELETES every user.
 *   3. CREATES exactly three, with known passwords:
 *
 *        admin  admin@vroomy.com   Admin@12345   role: admin
 *        owner  owner@revex.com    Owner@12345   role: owner
 *        rider  rider@revex.com    Rider@12345   role: user
 *
 * WHY DELETE AND RECREATE RATHER THAN PICK THREE
 *
 * Picking "one admin, one owner, one rider" out of the existing rows leaves
 * behind whatever password hashes those accounts happened to have, and leaves
 * behind any user whose role was edited by hand. The result is not
 * reproducible. Deleting and recreating means the three accounts always have
 * exactly the credentials printed below, which is the point of the exercise.
 *
 * The admin email is taken from ADMIN_EMAIL in backend/.env, so the server's
 * own ensureAdmin() step on boot does NOT create a fourth admin alongside it.
 *
 * SAFETY
 *
 *   node scripts/reset-to-demo-users.js --dry-run   # report, change nothing
 *   node scripts/reset-to-demo-users.js             # refuse: needs --yes
 *   node scripts/reset-to-demo-users.js --yes       # do it
 *
 * It also refuses to point at a database whose name does not look intentional,
 * so a stray MONGODB_URI cannot wipe an unrelated database.
 * ========================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
// bcryptjs, not bcrypt: it is what the rest of the backend uses (auth.js,
// admin.js) and it is a pure-JS root dependency, so there is no native build
// step to fail on a fresh machine. Hashes are interchangeable, so these
// accounts log in through the normal /api/auth/login path unchanged.
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CONFIRMED = args.includes('--yes');

/** Database names this script is willing to empty. */
const ALLOWED_DATABASES = ['vroomy', 'revex', 'revex_test', 'test'];

const DEMO_PASSWORD = {
  admin: 'Admin@12345',
  owner: 'Owner@12345',
  rider: 'Rider@12345'
};

function loadEnv() {
  const file = path.join(ROOT, 'backend', '.env');
  if (!fs.existsSync(file)) {
    console.error('backend/.env not found. Create it from backend/.env.example first.');
    process.exit(1);
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    // An existing process.env value always wins, so an operator can override.
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

function credentials() {
  // The admin email MUST match ADMIN_EMAIL, or server.js's ensureAdmin() will
  // create a second admin on the next boot and you will have four accounts.
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@vroomy.com').toLowerCase();
  return [
    { name: process.env.ADMIN_NAME || 'REVEX Admin', email: adminEmail, phone: '9800000001', role: 'admin', password: DEMO_PASSWORD.admin },
    { name: 'Ravi Owner', email: 'owner@revex.com', phone: '9800000002', role: 'owner', password: DEMO_PASSWORD.owner },
    { name: 'Riya Rider', email: 'rider@revex.com', phone: '9800000003', role: 'user', password: DEMO_PASSWORD.rider }
  ];
}

async function main() {
  loadEnv();

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || 'vroomy';
  if (!uri) {
    console.error('MONGODB_URI is not set. Put it in backend/.env.');
    process.exit(1);
  }
  if (!ALLOWED_DATABASES.includes(dbName)) {
    console.error(`Refusing to empty a database named "${dbName}".`);
    console.error(`Allowed names: ${ALLOWED_DATABASES.join(', ')}`);
    console.error('Set MONGODB_DB_NAME in backend/.env to one of those to proceed.');
    process.exit(1);
  }

  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;

  const existing = (await db.listCollections().toArray()).map(c => c.name).sort();
  const toDrop = existing.filter(name => name !== 'users');
  const counts = {};
  for (const name of existing) counts[name] = await db.collection(name).countDocuments();

  console.log(`target : ${dbName}`);
  console.log(`host   : ${new URL(uri).host}`);
  console.log('');
  console.log('current contents');
  for (const name of existing) {
    const mark = name === 'users' ? ' (all users deleted, 3 recreated)' : ' (DROPPED)';
    console.log(`  ${name.padEnd(26)} ${String(counts[name]).padStart(5)}${mark}`);
  }
  if (!existing.includes('users')) console.log('  (no users collection yet)');
  console.log('');

  const plan = credentials();
  console.log('the three accounts that will exist afterwards');
  plan.forEach(account => console.log(`  ${account.role.padEnd(6)} ${account.email.padEnd(24)} ${account.password}`));
  console.log('');

  if (DRY_RUN) {
    console.log('DRY RUN — nothing was changed. Re-run with --yes to apply.');
    await mongoose.disconnect();
    return;
  }
  if (!CONFIRMED) {
    console.log('This would permanently delete everything listed above.');
    console.log('Re-run with --yes if that is what you want.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // 1. Drop everything except users. drop() removes the collection and its
  //    indexes, so a stale unique index cannot reject the new documents.
  for (const name of toDrop) {
    await db.collection(name).drop();
    console.log(`dropped ${name}`);
  }

  // 2. Remove every user.
  const removed = await db.collection('users').deleteMany({});
  console.log(`deleted ${removed.deletedCount} user(s)`);

  // 3. Create exactly three. isVerified is true so none of them is blocked by a
  //    pending-verification wall, and the two counters start at zero.
  const now = new Date();
  for (const account of plan) {
    await db.collection('users').insertOne({
      name: account.name,
      email: account.email,
      phone: account.phone,
      photo: '',
      passwordHash: await bcrypt.hash(account.password, 10),
      role: account.role,
      isVerified: true,
      isActive: true,
      ownerEarnings: 0,
      totalCarsOnRent: 0,
      carApprovalStatus: 'approved',
      resetPasswordToken: null,
      deactivatedAt: null,
      createdAt: now,
      updatedAt: now
    });
    console.log(`created ${account.role.padEnd(6)} ${account.email}`);
  }

  // The unique email index has to exist or the first duplicate registration
  // would quietly create a second account.
  await db.collection('users').createIndex({ email: 1 }, { unique: true, name: 'email_1' });

  /* ------------------------------------------------------------- verify */
  console.log('');
  const after = (await db.listCollections().toArray()).map(c => c.name).sort();
  const users = await db.collection('users').find({}, { projection: { name: 1, email: 1, role: 1, isVerified: 1, _id: 0 } }).sort({ role: 1 }).toArray();

  console.log('afterwards');
  console.log(`  collections : ${after.join(', ') || '(none)'}`);
  console.log(`  users       : ${users.length}`);
  users.forEach(user => console.log(`    ${user.role.padEnd(6)} ${user.email.padEnd(24)} verified=${user.isVerified}`));
  console.log('');

  if (after.length !== 1 || after[0] !== 'users') {
    console.error('UNEXPECTED: collections other than `users` still exist.');
    process.exitCode = 1;
  }
  if (users.length !== 3) {
    console.error(`UNEXPECTED: expected 3 users, found ${users.length}.`);
    process.exitCode = 1;
  }
  const roles = users.map(u => u.role).sort().join(',');
  if (roles !== 'admin,owner,user') {
    console.error(`UNEXPECTED: expected one of each role, found: ${roles}`);
    process.exitCode = 1;
  }

  console.log('Sign in with');
  plan.forEach(account => console.log(`  ${account.email.padEnd(24)} ${account.password}   (${account.role})`));
  console.log('');
  console.log('Done. Restart the server so the in-memory rate limiter clears.');

  await mongoose.disconnect();
}

main().catch(error => {
  console.error('Reset failed:', error.message);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});

/**
 * Exports every collection in the connected MongoDB database to JSON.
 *
 * Run it with:  node scripts/export-database.js
 * It writes one file per collection into ./database/collections and an
 * index.json describing what was exported and when.
 *
 * WHY THIS EXISTS
 * ---------------
 * The .env points at a MongoDB Atlas cluster, which is a *live remote*
 * database - not something that travels inside a project folder. A copy of
 * this project on another machine is therefore only half complete: the code
 * arrives, the data does not. This script makes the data travel with the code
 * as plain readable JSON, so the project can be inspected, archived, diffed or
 * loaded into a local MongoDB without needing Atlas credentials.
 *
 * Passwords are hashed, so a dump is still sensitive: the file contains every
 * user record. Treat ./database/ the way you would treat the live database, and
 * never commit it to a public repository.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, 'backend', '.env') });
require('dotenv').config({ path: path.join(ROOT, '.env') });

const mongoose = require('mongoose');
const { connectMongo } = require(path.join(ROOT, 'backend', 'utils', 'db.js'));

const OUT = path.join(ROOT, 'database', 'collections');

/** BSON types that JSON.stringify cannot represent usefully. */
function replacer(key, value) {
  if (value && typeof value === 'object' && value._bsontype) {
    // ObjectId, Date, Decimal128 and friends keep a readable form.
    if (value._bsontype === 'ObjectId') return `ObjectId(${value.toHexString()})`;
    if (value._bsontype === 'Date') return value.toISOString();
    if (value._bsontype === 'Decimal128') return value.toString();
    if (value._bsontype === 'Binary') return value.buffer.toString('base64');
    return value.toString();
  }
  return value;
}

(async () => {
  const target = process.argv[2] || path.join(OUT);
  fs.mkdirSync(target, { recursive: true });

  console.log('[export] connecting...');
  const info = await connectMongo();
  const db = mongoose.connection.db;
  const names = (await db.listCollections().toArray())
    .map(entry => entry.name)
    .sort();

  const index = {
    exportedAt: new Date().toISOString(),
    database: info.database,
    mode: info.mode,
    collections: []
  };

  for (const name of names) {
    const docs = await db.collection(name).find({}).toArray();
    // Pretty-printed: a diff between two exports is then readable, which is
    // most of the point of having the dump as text.
    const file = path.join(target, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(docs, replacer, 2), 'utf8');
    const bytes = fs.statSync(file).size;
    index.collections.push({ name, documents: docs.length, bytes });
    console.log(`[export] ${name.padEnd(28)} ${String(docs.length).padStart(5)} docs  ${(bytes / 1024).toFixed(1)} KB`);
  }

  fs.writeFileSync(
    path.join(ROOT, 'database', 'index.json'),
    JSON.stringify(index, null, 2),
    'utf8'
  );

  const total = index.collections.reduce((sum, entry) => sum + entry.documents, 0);
  console.log(`\n[export] done. ${names.length} collection(s), ${total} document(s) -> ${target}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async error => {
  console.error('[export] failed:', error.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});

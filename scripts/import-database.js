/**
 * Loads a database export (see scripts/export-database.js) back into MongoDB.
 *
 * Run it with:  node scripts/import-database.js
 *
 * Reads ./database/collections/*.json and writes each collection into whatever
 * database backend/.env points at.
 *
 * DEFAULT IS SAFE: without --wipe it only inserts documents whose _id is not
 * already there, so running it against the live database adds nothing and
 * changes nothing. It refuses to touch the live Atlas cluster at all unless
 * you also pass --allow-live, because a restore is the one operation in this
 * project that can destroy real data.
 *
 *   node scripts/import-database.js --wipe            # wipe + load, local only
 *   node scripts/import-database.js --wipe --allow-live
 *   node scripts/import-database.js --dry-run         # report only, write nothing
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, 'backend', '.env') });
require('dotenv').config({ path: path.join(ROOT, '.env') });

const mongoose = require('mongoose');
const { connectMongo } = require(path.join(ROOT, 'backend', 'utils', 'db.js'));

const DIR = path.join(ROOT, 'database', 'collections');

/** Reverses the readable form written by export-database.js. */
function reviveId(value) {
  const match = /^ObjectId\(([0-9a-f]{24})\)$/.exec(value);
  return match ? new mongoose.Types.ObjectId(match[1]) : value;
}

function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    if (value._id && typeof value._id === 'string') value._id = reviveId(value._id);
    for (const key of Object.keys(value)) value[key] = revive(value[key]);
  }
  return value;
}

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');
const wipe = flags.has('--wipe');
const allowLive = flags.has('--allow-live');

(async () => {
  if (!fs.existsSync(DIR)) {
    console.error(`[import] no export found at ${DIR}`);
    console.error('[import] run "node scripts/export-database.js" on a machine that has the data first.');
    process.exit(1);
  }

  console.log('[import] connecting...');
  const info = await connectMongo();
  const db = mongoose.connection.db;

  // A remote cluster is someone's real data. A restore can delete every
  // collection it is pointed at, so make the user say so out loud.
  if (info.mode === 'atlas' && !allowLive) {
    console.error('\n[import] REFUSING TO WRITE.');
    console.error(`[import] .env points at a remote MongoDB ATLAS cluster (${info.database}).`);
    console.error('[import] A restore here can overwrite real production data.');
    console.error('[import] Re-run with --allow-live if that is genuinely what you want,\n' +
                  '        or set MONGODB_FALLBACK_URI + ALLOW_LOCAL_MONGO_FALLBACK=true\n' +
                  '        in backend/.env to load into a local MongoDB instead.\n');
    await mongoose.disconnect();
    process.exit(1);
  }

  const files = fs.readdirSync(DIR).filter(name => name.endsWith('.json')).sort();
  const summary = [];

  for (const file of files) {
    const name = path.basename(file, '.json');
    const docs = revive(JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')));
    if (dryRun) {
      summary.push({ name, wouldLoad: docs.length });
      console.log(`[import] (dry run) ${name.padEnd(28)} ${String(docs.length).padStart(5)} docs`);
      continue;
    }
    if (wipe) {
      await db.collection(name).deleteMany({});
      console.log(`[import] wiped  ${name}`);
    }
    if (docs.length) await db.collection(name).insertMany(docs, { ordered: false });
    summary.push({ name, loaded: docs.length });
    console.log(`[import] loaded  ${name.padEnd(28)} ${String(docs.length).padStart(5)} docs`);
  }

  const total = summary.reduce((sum, entry) => sum + (entry.wouldLoad ?? entry.loaded ?? 0), 0);
  console.log(`\n[import] ${dryRun ? 'would load' : 'loaded'} ${files.length} collection(s), ${total} document(s) into "${info.database}".`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async error => {
  console.error('[import] failed:', error.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});

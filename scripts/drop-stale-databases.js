/**
 * Drops leftover databases on the cluster that REVEX no longer uses.
 *
 * Before MONGODB_DB_NAME was made explicit, the app connected without a
 * database path and Atlas silently used "test". Everything from that era is
 * stale QA data and is not read by the app any more.
 *
 * Only databases that are NOT the configured one and NOT Atlas's own sample
 * database are considered. "sample_mflix" is left alone because it ships with
 * every new Atlas cluster and is not ours to remove.
 *
 *   node scripts/drop-stale-databases.js            # dry run
 *   node scripts/drop-stale-databases.js --apply
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { buildMongoUri } = require('../backend/utils/db');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const KEEP = new Set(['admin', 'local', 'config', 'sample_mflix']);

(async () => {
  const active = process.env.MONGODB_DB_NAME || 'vroomy';
  await mongoose.connect(buildMongoUri(process.env.MONGODB_URI, active), { serverSelectionTimeoutMS: 15000, family: 4 });
  const admin = mongoose.connection.db.admin();
  const { databases } = await admin.listDatabases();

  const stale = databases.filter(d => d.name !== active && !KEEP.has(d.name));

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — stale database cleanup\n`);
  console.log(`  active database (kept) : ${active}`);
  console.log(`  system / sample (kept): ${[...KEEP].join(', ')}`);
  console.log(`  stale (candidates)    : ${stale.length}\n`);

  for (const db of stale) {
    let collections = 0;
    try {
      const sibling = mongoose.connection.useDb(db.name, { useCache: false });
      collections = (await sibling.db.listCollections().toArray()).length;
    } catch { /* ignore */ }
    console.log(`    ${db.name.padEnd(16)} ${String(db.sizeOnDisk).padStart(12)} bytes, ${collections} collection(s)`);
  }
  if (!stale.length) console.log('    (none)');

  if (!APPLY) {
    console.log('\n  Re-run with --apply to drop them.\n');
    await mongoose.disconnect();
    return;
  }

  for (const db of stale) {
    const sibling = mongoose.connection.useDb(db.name, { useCache: false });
    await sibling.dropDatabase();
    console.log(`  dropped: ${db.name}`);
  }

  const after = await admin.listDatabases();
  console.log(`\n  databases remaining: ${after.databases.map(d => d.name).join(', ')}`);
  await mongoose.disconnect();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });

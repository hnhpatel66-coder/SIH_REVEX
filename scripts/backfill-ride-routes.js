#!/usr/bin/env node
/**
 * BACKFILL RIDE ROUTES  (scripts/backfill-ride-routes.js)
 *
 * WHY THIS EXISTS
 *
 * Smart Route stores a ride's real driving road on the Ride document. Rides
 * created AFTER this feature shipped have it, computed automatically when the
 * owner publishes the offer. Rides that were already in the database when the
 * feature was added have nothing: no geometry, no via towns, no distance, and
 * so no way for a mid-route rider to ever find them.
 *
 * Rather than migrate them, this recomputes the same roads through the same code
 * path the API uses (backend/utils/rideRoute.js), so a repaired ride is
 * indistinguishable from one created today. It is safe to run repeatedly: a ride
 * that already has a road is skipped unless --force is passed.
 *
 * WHAT IT DOES NOT DO
 *
 * It never deletes a ride, never changes its price, status, seats or times, and
 * never touches a booking. A ride whose road cannot be computed is left exactly
 * as it was and reported, with the reason - because a ride offer that already
 * works is more valuable than a ride offer with a map on it.
 *
 * USAGE
 *   node scripts/backfill-ride-routes.js              # repair rides with no road
 *   node scripts/backfill-ride-routes.js --dry-run    # report only, change nothing
 *   node scripts/backfill-ride-routes.js --force      # recompute every ride
 *   node scripts/backfill-ride-routes.js --id <id>    # one ride, for a spot check
 *   node scripts/backfill-ride-routes.js --all        # include cancelled offers
 *
 * Requires backend/.env with a working MONGODB_URI. For real road geometry you
 * also want MAPBOX_ACCESS_TOKEN; without it the run still succeeds using the
 * key-free public OSRM router, and reports which provider it used.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Ride = require('../backend/models/Ride');
const { computeAndStoreRoute } = require('../backend/utils/rideRoute');
const mapbox = require('../backend/utils/mapbox');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const ALL = process.argv.includes('--all');
const ONLY_ID = (() => {
  const at = process.argv.indexOf('--id');
  return at > -1 ? process.argv[at + 1] : '';
})();

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const status = mapbox.describeStatus();
  console.log(`[backfill] road data source: ${status.roadDataSource}`);
  if (status.roadDataSource !== 'mapbox') {
    console.log('[backfill] note: no Mapbox secret token is configured, so geometry will come from the fallback provider instead.');
  }
  if (status.problem) console.log(`[backfill] warning: ${status.problem}`);

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
  console.log(`[backfill] connected to database "${mongoose.connection.name}"`);

  const filter = { from: { $exists: true, $ne: '' }, to: { $exists: true, $ne: '' } };
  if (ONLY_ID) {
    if (!mongoose.isValidObjectId(ONLY_ID)) {
      console.error(`"${ONLY_ID}" is not a ride id.`);
      await mongoose.disconnect();
      process.exit(1);
    }
    filter._id = ONLY_ID;
  } else if (!ALL && !FORCE) {
    // Without a road, or with a recorded failure. This is the set that actually
    // needs repairing, and it keeps a large production run short.
    filter.$or = [{ routeGeometry: { $exists: false } }, { routeGeometry: { $in: [null, []] } }, { routeError: { $nin: ['', null] } }];
  }

  const rides = await Ride.find(filter).select('+routeGeometry').sort({ createdAt: 1 });
  console.log(`[backfill] ${rides.length} ride(s) to examine${DRY_RUN ? ' (dry run, nothing will be written)' : ''}.`);

  const summary = { done: 0, skipped: 0, failed: 0 };
  for (const ride of rides) {
    const label = `${ride._id} · ${ride.from} to ${ride.to}`;
    const hasRoad = Array.isArray(ride.routeGeometry) && ride.routeGeometry.length > 1;
    if (hasRoad && !FORCE) {
      summary.skipped += 1;
      continue;
    }
    if (DRY_RUN) {
      console.log(`  would route  ${label}`);
      continue;
    }
    const result = await computeAndStoreRoute(ride);
    if (result.ok) {
      summary.done += 1;
      console.log(`  routed       ${label} · ${result.distanceKm} km via ${result.provider}${result.note ? ` · ${result.note}` : ''}`);
    } else {
      summary.failed += 1;
      console.log(`  could not    ${label} · ${result.error}`);
    }
  }

  console.log(`[backfill] done. routed ${summary.done}, skipped ${summary.skipped}, could not route ${summary.failed}.`);
  if (summary.failed) {
    console.log('[backfill] those rides still work exactly as before, they just have no road on the map.');
    console.log('[backfill] run scripts/verify-live.js to confirm the API is healthy either way.');
  }
  await mongoose.disconnect();
}

main().catch(error => {
  console.error('[backfill] failed:', error.message);
  mongoose.disconnect().finally(() => process.exit(1));
});

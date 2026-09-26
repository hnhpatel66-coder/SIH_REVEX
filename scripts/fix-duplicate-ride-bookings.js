#!/usr/bin/env node
/**
 * REPAIR DUPLICATE ACTIVE RIDE BOOKINGS
 * (scripts/fix-duplicate-ride-bookings.js)
 *
 * WHY THIS EXISTS
 *
 * `RideBooking` carries a partial unique index
 *
 *   { rideId, userId } unique where status in
 *     (payment_pending, pending_owner, confirmed)
 *
 * so one rider can never hold two live seat requests on the same ride. MongoDB
 * can only create that index if no document already violates it, and older
 * REVEX builds had no such guard, so a database that was live before 1.3 can
 * already contain duplicates. When that happens:
 *
 *   - the API still refuses new duplicates (it checks before booking), so no
 *     new double-booking is possible;
 *   - but the index cannot be created, so it is reported once at boot with a
 *     pointer to this script.
 *
 * WHAT IT DOES
 *
 * For every duplicated (rideId, userId) group it keeps ONE booking - the
 * earliest, preferring a paid one - and marks the rest `cancelled` with a
 * reason that says exactly why. Nothing is deleted: a cancelled booking with
 * its audit trail is correct data, and a silently deleted one would be a lie.
 *
 * It then rebuilds the index.
 *
 * Usage:
 *   node scripts/fix-duplicate-ride-bookings.js            # repair + report
 *   node scripts/fix-duplicate-ride-bookings.js --dry-run  # report only
 *
 * Requires backend/.env with a working MONGODB_URI.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const RideBooking = require('../backend/models/RideBooking');

const LIVE = ['payment_pending', 'pending_owner', 'confirmed'];
const INDEX_NAME = 'active_ride_booking_unique';
const DRY_RUN = process.argv.includes('--dry-run');

/** The one booking that survives: prefer a paid one, then the earliest. */
function pickKeeper(bookings) {
  return [...bookings].sort((a, b) => {
    const paidA = a.paymentStatus === 'paid' ? 0 : 1;
    const paidB = b.paymentStatus === 'paid' ? 0 : 1;
    if (paidA !== paidB) return paidA - paidB;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  })[0];
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
  console.log(`[fix] connected to database "${mongoose.connection.name}"`);

  const groups = await RideBooking.aggregate([
    { $match: { status: { $in: LIVE } } },
    { $group: { _id: { rideId: '$rideId', userId: '$userId' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } }
  ]);

  if (!groups.length) {
    console.log('[fix] no duplicate active ride bookings found.');
  } else {
    console.log(`[fix] ${groups.length} duplicated (ride, rider) pair(s) found.`);
    for (const group of groups) {
      const bookings = await RideBooking.find({ _id: { $in: group.ids } });
      const keeper = pickKeeper(bookings);
      const extras = bookings.filter(booking => String(booking._id) !== String(keeper._id));
      console.log(`  ride ${group._id.rideId} · rider ${group._id.userId} · ${group.count} live booking(s)`);
      console.log(`    keeping ${keeper._id} (${keeper.status}, ${keeper.paymentStatus}, ${keeper.createdAt})`);
      for (const extra of extras) {
        console.log(`    ${DRY_RUN ? 'would cancel' : 'cancelling'} ${extra._id} (${extra.status}, ${extra.paymentStatus}, ${extra.createdAt})`);
        if (!DRY_RUN) {
          extra.status = 'cancelled';
          extra.cancellation = {
            cancelledBy: 'admin',
            reason: 'Duplicate active seat request merged by scripts/fix-duplicate-ride-bookings.js. No additional payment was taken.',
            cancelledAt: new Date(),
            originalAmount: extra.paidAmount || 0,
            // A duplicate is never charged twice, so nothing is refunded here.
            cancellationFee: 0,
            refundAmount: 0,
            finalAmount: 0,
            explanation: 'This was a duplicate of another active seat request on the same ride. It was merged, not charged.'
          };
          await extra.save();
        }
      }
    }
  }

  if (!DRY_RUN) {
    try {
      await RideBooking.collection.createIndex(
        { rideId: 1, userId: 1 },
        { unique: true, partialFilterExpression: { status: { $in: LIVE } }, name: INDEX_NAME }
      );
      console.log(`[fix] index "${INDEX_NAME}" is now in place.`);
    } catch (error) {
      console.error(`[fix] the index could still not be created: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    console.log('[fix] dry run: nothing was written.');
  }

  await mongoose.disconnect();
}

main().catch(error => { console.error('[fix] failed:', error.message); process.exit(1); });

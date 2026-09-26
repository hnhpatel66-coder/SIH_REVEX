#!/usr/bin/env node
/**
 * STATUS VOCABULARY  (tests/statuses.test.js)
 *
 * Before 1.3 every route invented its own status strings, so the same state had
 * different names in the rental flow, the ride flow, the database and the UI.
 * backend/utils/statuses.js is the single vocabulary; these tests pin the parts
 * the rest of the system relies on:
 *
 *   - backward compatibility: pre-1.0 values still load,
 *   - a cancelled record is recognised however it was cancelled,
 *   - a booking that still holds a seat is recognised,
 *   - the label maps cover every status the models can actually store.
 */
'use strict';

const { createSuite } = require('./harness');
const statuses = require('../backend/utils/statuses');

const t = createSuite('status vocabulary');
const {
  RIDE_STATUS, RIDE_STATUS_ALIASES, RIDE_STATUS_LABELS, PUBLIC_RIDE_STATUSES,
  VEHICLE_STATUS, VEHICLE_STATUS_ALIASES, VEHICLE_STATUS_LABELS,
  BOOKING_STATUS, BOOKING_STATUS_LABELS, BOOKING_ACTIVE_STATUSES, BOOKING_CANCELLED_STATUSES,
  RIDE_BOOKING_STATUS, RIDE_BOOKING_STATUS_LABELS, RIDE_BOOKING_ACTIVE_STATUSES, RIDE_BOOKING_CANCELLED_STATUSES,
  PAYMENT_STATUS, CANCELLED_BY, cancelledStatusFor, isCancelled, labelFor
} = statuses;

t.describe('ride statuses', () => {
  t.equal(RIDE_STATUS.APPROVED, 'approved', 'an approved ride is stored as "approved"');
  t.equal(RIDE_STATUS_ALIASES.available, RIDE_STATUS.APPROVED, 'the pre-1.0 "available" maps onto approved');
  t.equal(PUBLIC_RIDE_STATUSES.includes('approved'), true, 'approved rides are publicly bookable');
  t.equal(PUBLIC_RIDE_STATUSES.includes('pending'), false, 'a ride awaiting approval is never public');
  t.ok(Object.keys(RIDE_STATUS_LABELS).length >= 6, 'every ride status has a human label');
});

t.describe('vehicle statuses', () => {
  t.equal(VEHICLE_STATUS_ALIASES.available, VEHICLE_STATUS.APPROVED, '"available" is read as approved');
  t.equal(VEHICLE_STATUS_ALIASES.unavailable, VEHICLE_STATUS.REMOVED, '"unavailable" is read as removed');
  t.ok(Object.keys(VEHICLE_STATUS_LABELS).length >= 4, 'every vehicle status has a human label');
});

t.describe('rental booking statuses', () => {
  t.ok(BOOKING_ACTIVE_STATUSES.includes(BOOKING_STATUS.PAYMENT_PENDING), 'an unpaid booking still holds the vehicle');
  t.ok(BOOKING_ACTIVE_STATUSES.includes(BOOKING_STATUS.PENDING_OWNER), 'a paid booking awaiting the owner still holds the vehicle');
  t.ok(BOOKING_ACTIVE_STATUSES.includes(BOOKING_STATUS.CONFIRMED), 'a confirmed booking holds the vehicle');
  t.equal(BOOKING_ACTIVE_STATUSES.includes(BOOKING_STATUS.CANCELLED_BY_USER), false, 'a cancelled booking releases the vehicle');
  t.equal(BOOKING_ACTIVE_STATUSES.includes(BOOKING_STATUS.REJECTED), false, 'a declined booking releases the vehicle');

  t.equal(BOOKING_CANCELLED_STATUSES.includes(BOOKING_STATUS.CANCELLED), true, 'the legacy umbrella "cancelled" is still a cancellation');
  t.equal(BOOKING_CANCELLED_STATUSES.includes(BOOKING_STATUS.CANCELLED_BY_ADMIN), true, 'an admin cancellation is a cancellation');
  t.equal(isCancelled(BOOKING_STATUS.CANCELLED_BY_OWNER), true, 'isCancelled understands every cancellation variant');
  t.equal(isCancelled(BOOKING_STATUS.CONFIRMED), false, 'a confirmed booking is not a cancellation');
  t.equal(isCancelled(undefined), false, 'an unknown value is not silently treated as cancelled');
});

t.describe('ride booking statuses', () => {
  t.ok(RIDE_BOOKING_ACTIVE_STATUSES.includes(RIDE_BOOKING_STATUS.PAYMENT_PENDING), 'an unpaid seat hold is active');
  t.ok(RIDE_BOOKING_ACTIVE_STATUSES.includes(RIDE_BOOKING_STATUS.PENDING_OWNER), 'a paid request awaiting the driver is active');
  t.ok(RIDE_BOOKING_ACTIVE_STATUSES.includes(RIDE_BOOKING_STATUS.CONFIRMED), 'a confirmed seat is active');
  t.equal(RIDE_BOOKING_ACTIVE_STATUSES.includes(RIDE_BOOKING_STATUS.REJECTED), false, 'a declined request releases the seat');
  t.ok(RIDE_BOOKING_CANCELLED_STATUSES.includes('cancelled'), 'the legacy umbrella is still accepted for rides');
});

t.describe('cancellation actor mapping', () => {
  t.equal(cancelledStatusFor('user'), 'cancelled_by_user', 'a rider cancellation is attributed to the rider');
  t.equal(cancelledStatusFor('owner'), 'cancelled_by_owner', 'an owner cancellation is attributed to the owner');
  t.equal(cancelledStatusFor('admin'), 'cancelled_by_admin', 'an admin cancellation is attributed to the admin');
  t.equal(cancelledStatusFor('ADMIN'), 'cancelled_by_admin', 'the actor name is case-insensitive');
  t.equal(cancelledStatusFor('nonsense'), 'cancelled', 'an unknown actor falls back to the umbrella value, never to a privileged one');
  t.equal(CANCELLED_BY.ADMIN, 'admin', 'the admin actor constant is stable');
});

t.describe('labels cover every stored value', () => {
  for (const value of Object.values(BOOKING_STATUS)) {
    t.ok(BOOKING_STATUS_LABELS[value], `rental booking status "${value}" has a label`);
  }
  for (const value of Object.values(RIDE_BOOKING_STATUS)) {
    t.ok(RIDE_BOOKING_STATUS_LABELS[value], `ride booking status "${value}" has a label`);
  }
  for (const value of Object.values(PAYMENT_STATUS)) {
    t.ok(typeof value === 'string' && value.length, `payment status "${value}" is defined`);
  }
  t.equal(labelFor('nonsense', BOOKING_STATUS_LABELS), 'nonsense', 'an unknown status is shown verbatim rather than hidden');
  t.equal(labelFor('', BOOKING_STATUS_LABELS), 'Unknown', 'an empty status reads as Unknown');
});

t.describe('the two approval systems are separate', () => {
  t.ok(!Object.values(RIDE_STATUS).includes('pending_owner'), 'an approved ride offer is never "awaiting owner approval"');
  t.ok(!Object.values(RIDE_BOOKING_STATUS).includes('approved'), 'a seat request is never stored as the offer status "approved"');
  t.ok(Object.values(RIDE_BOOKING_STATUS).includes('pending_owner'), 'the owner decision lives on the seat booking only');
});

t.done();

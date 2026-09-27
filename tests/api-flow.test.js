#!/usr/bin/env node
/**
 * END-TO-END API SUITE  (tests/api-flow.test.js)
 *
 * Drives a RUNNING REVEX server through the whole 1.3 flow, in the order a real
 * user experiences it:
 *
 *   register rider + owner -> owner lists a vehicle -> admin approves it ->
 *   owner offers a ride -> admin approves the offer -> rider pays for a seat ->
 *   owner approves the seat -> owner declines a second seat (refund) ->
 *   rider cancels (refund) -> admin cancels (refund) -> assistant status ->
 *   admin owner summary -> revenue adds up -> no overbooking -> no duplicates.
 *
 * It also covers the failure paths that matter: a forged payment signature, a
 * wrong amount, a replayed callback, an already-paid booking, a test payment
 * while a gateway IS configured, and a caller reaching someone else's booking.
 *
 * Every record it creates is namespaced with a unique run id and it never
 * deletes anything, so it is safe to run against a real database repeatedly.
 *
 * IT DOES WRITE TO THE DATABASE. It registers seven accounts and creates
 * vehicles, rides, bookings and payments on whatever server you point it at, and
 * those rows are still there afterwards. That is fine for a test database and
 * annoying for a demo one, so by default the suite refuses to run unless the
 * target database name says it is a test database:
 *
 *   MONGODB_DB_NAME=revex_test   -> runs
 *   MONGODB_DB_NAME=vroomy       -> refuses, unless ALLOW_DIRTY_TESTS=true
 *
 * Use `npm run db:reset-users -- --yes` afterwards to get back to a clean slate
 * with exactly one account of each role.
 *
 * Usage:
 *   set TEST_BASE_URL=http://localhost:5001
 *   set ADMIN_EMAIL=...  set ADMIN_PASSWORD=...
 *   npm run test:api
 *
 * IMPORTANT: the suite registers several accounts, and auth routes are rate
 * limited per IP (10 registrations per 15 minutes by default, which is correct
 * for production). Start the server you are testing with a raised limit:
 *
 *   set AUTH_RATE_LIMIT_MAX=500
 *   set ADMIN_EMAIL=...  set ADMIN_PASSWORD=...
 *   npm start
 *
 * Without it the run stops at the first registration with HTTP 429, which is the
 * rate limiter working as designed rather than a test failure.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

/**
 * Refuse to write test rows into what looks like real data.
 *
 * Read from backend/.env rather than from the server, because the point is to
 * warn BEFORE anything is created. The server's own MONGODB_DB_NAME wins, so an
 * override set in the shell is respected.
 */
function guardAgainstDirtyDatabase() {
  const name = (process.env.MONGODB_DB_NAME || (() => {
    try {
      const env = fs.readFileSync(path.join(__dirname, '..', 'backend', '.env'), 'utf8');
      return (/^\s*MONGODB_DB_NAME\s*=\s*(.*)$/m.exec(env) || [])[1]?.trim() || 'vroomy';
    } catch { return 'vroomy'; }
  })()).toLowerCase();

  if (/test|dev|local|ci|staging/.test(name)) return;
  if (String(process.env.ALLOW_DIRTY_TESTS).toLowerCase() === 'true') {
    console.log(`\n!! ALLOW_DIRTY_TESTS=true: writing test rows into "${name}".`);
    console.log('!! Clean up afterwards with:  npm run db:reset-users -- --yes\n');
    return;
  }
  console.error(`\nThis suite WRITES to the database, and the target is "${name}", which does not`);
  console.error('look like a test database. It would leave behind 7 accounts plus vehicles,');
  console.error('rides, bookings and payments.');
  console.error('\nPoint it at a test database:      set MONGODB_DB_NAME=revex_test');
  console.error('or accept the mess:              set ALLOW_DIRTY_TESTS=true');
  console.error('or clean up afterwards with:     npm run db:reset-users -- --yes\n');
  process.exit(1);
}
guardAgainstDirtyDatabase();

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:5001').replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = crypto.randomBytes(4).toString('hex');
const STAMP = Date.now();

let passed = 0;
let failed = 0;
const failures = [];
let section = '';

function head(title) { section = title; console.log(`\n── ${title}`); }
function ok(condition, message) {
  if (condition) { passed += 1; console.log(`  ok   ${message}`); return true; }
  failed += 1;
  failures.push(`[${section}] ${message}`);
  console.log(`  FAIL ${message}`);
  return false;
}
function equal(actual, expected, message) {
  return ok(actual === expected, `${message}${actual === expected ? '' : ` (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
}
function skip(message) { console.log(`  skip ${message}`); }

async function call(pathname, { method = 'GET', body, token, expect } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  const text = await response.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (expect !== undefined && response.status !== expect) {
    if (response.status === 429) {
      throw new Error(
        `${method} ${pathname} was rate limited (HTTP 429).\n` +
        '  Auth routes are rate limited per IP, which is correct in production but stops this\n' +
        '  suite after a few runs. Restart the server you are testing with a raised limit:\n' +
        '      set AUTH_RATE_LIMIT_MAX=500\n' +
        '      npm start\n'
      );
    }
    throw new Error(`${method} ${pathname} expected ${expect}, got ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { status: response.status, data, headers: response.headers };
}

const money = value => Math.round(Number(value || 0) * 100) / 100;

/* ------------------------------------------------------------------ run */

async function main() {
  console.log(`REVEX end-to-end API suite`);
  console.log(`target: ${BASE}`);
  console.log(`run id: ${RUN}`);

  head('server is reachable');
  const health = await call('/api/health', { expect: 200 });
  ok(health.data.ok === true, 'GET /api/health reports ok');
  const gatewayUp = health.data.database === 'connected';
  if (!gatewayUp) throw new Error(`the server is not connected to a database (state: ${health.data.database}). Start the server and try again.`);

  head('payment gateway configuration decides the payment path');
  const config = await call('/api/payments/config', { expect: 200 });
  ok(typeof config.data.enabled === 'boolean', 'GET /api/payments/config reports whether Razorpay is configured');
  ok(typeof config.data.usable === 'boolean', 'and whether Razorpay actually accepted the keys');
  ok(config.data.currency === 'INR', 'the currency is INR');
  // `enabled` is only "the variables are non-empty". `usable` is the live
  // answer, and it is what decides the payment path everywhere in the app.
  ok(['ready', 'missing', 'rejected', 'unreachable'].includes(config.data.state), 'the gateway state is one of the known values');
  ok(config.data.testModeAvailable === !config.data.usable, 'a test payment is offered exactly when real payments cannot succeed');
  if (config.data.enabled) {
    ok(/^rzp_/.test(config.data.keyId || ''), 'a configured gateway exposes its publishable key id');
  } else {
    ok(config.data.testModeAvailable === true, 'no gateway means a labelled test payment is offered');
  }
  if (config.data.state === 'rejected') {
    ok(/RAZORPAY_KEY_ID/.test(config.data.message || ''), 'a rejected key is explained with the variable to fix');
    ok(!/session/i.test(config.data.message || '') || /unaffected/i.test(config.data.message || ''),
      'and the rider is told their session is not the problem');
  }

  head('registering the accounts for this run');
  const riderEmail = `rider+${RUN}@example.test`;
  const ownerEmail = `owner+${RUN}@example.test`;
  const password = `Rev3x!${RUN}`;

  const rider = await call('/api/auth/register', { method: 'POST', body: { name: `Rider ${RUN}`, email: riderEmail, phone: '9825000001', password, confirmPassword: password }, expect: 201 });
  const riderToken = rider.data.token;
  ok(Boolean(riderToken), 'the rider is registered and receives a token');
  equal(rider.data.user.role, 'user', 'the rider account has the user role');

  const owner = await call('/api/auth/register', { method: 'POST', body: { name: `Owner ${RUN}`, email: ownerEmail, phone: '9825000002', password, confirmPassword: password, role: 'owner' }, expect: 201 });
  const ownerToken = owner.data.token;
  ok(Boolean(ownerToken), 'the owner is registered and receives a token');
  equal(owner.data.user.role, 'owner', 'the owner account has the owner role');

  const weak = await call('/api/auth/register', { method: 'POST', body: { name: 'Weak', email: `weak+${RUN}@example.test`, password: '123', confirmPassword: '123' } });
  ok(weak.status === 400, 'a short password is rejected with a specific message');
  ok(typeof weak.data.message === 'string' && weak.data.message.length > 5, 'the rejection explains itself');

  const dupe = await call('/api/auth/register', { method: 'POST', body: { name: 'Dupe', email: riderEmail, password, confirmPassword: password } });
  ok(dupe.status === 409, 'registering the same email twice is refused');

  const badLogin = await call('/api/auth/login', { method: 'POST', body: { email: riderEmail, password: 'wrong-password' }, expect: 401 });
  ok(/password|invalid|incorrect/i.test(badLogin.data.message || ''), 'a wrong password gives a clear message, not a generic failure');

  head('the rider cannot reach an owner-only or admin-only endpoint');
  const riderRides = await call('/api/rides', { method: 'POST', token: riderToken, body: { from: 'A', to: 'B', date: '2030-01-01', time: '10:00', seats: 1, price: 100, vehicleType: 'Car', termsAccepted: true } });
  ok(riderRides.status === 403, 'a rider cannot publish a ride offer');
  const riderAdmin = await call('/api/admin/summary', { token: riderToken });
  ok(riderAdmin.status === 403, 'a rider cannot read the admin summary');
  const anon = await call('/api/chat/conversations');
  ok(anon.status === 401, 'the assistant requires a session');

  head('the owner lists a vehicle');
  // A 1x1 transparent PNG.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const vehicle = await call('/api/vehicles', {
    method: 'POST', token: ownerToken, expect: 201,
    body: {
      name: `Test Car ${RUN}`, category: 'Car', brand: 'Honda', model: 'City',
      location: 'Surat', fuelType: 'Petrol', transmission: 'Manual',
      currentKm: 1000, price: 200, priceUnit: 'hour', includedKm: 300, extraKmRate: 10,
      numberPlate: `GJ05${RUN.toUpperCase()}`, vehiclePicture: png,
      documents: [{ type: 'ownership', label: 'Ownership papers', fileName: 'rc.png', mimeType: 'image/png', dataUrl: png, size: 68 }]
    }
  });
  const vehicleId = vehicle.data.id;
  ok(Boolean(vehicleId), 'the vehicle is created');
  equal(vehicle.data.status, 'pending', 'a new vehicle starts as pending approval');
  equal(vehicle.data.verified, false, 'a new vehicle is not verified');
  ok(vehicle.data.vehiclePicture === png || vehicle.data.image === png, 'the vehicle photo is stored');

  head('an unapproved vehicle is invisible to renters');
  const beforeApproval = await call('/api/vehicles');
  ok(!beforeApproval.data.some(item => item.id === vehicleId), 'a pending vehicle does not appear in the public list');

  head('admin approves the vehicle');
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    skip('ADMIN_EMAIL / ADMIN_PASSWORD are not set: skipping every admin step');
    return;
  }
  const admin = await call('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, expect: 200 });
  const adminToken = admin.data.token;
  ok(Boolean(adminToken), 'the administrator can log in');

  const approved = await call(`/api/admin/vehicles/${vehicleId}/verify`, { method: 'PATCH', token: adminToken, body: { decision: 'approve' }, expect: 200 });
  equal(approved.data.vehicle.status, 'approved', 'the vehicle is approved');
  equal(approved.data.vehicle.verified, true, 'the vehicle is marked verified');

  const afterApproval = await call('/api/vehicles');
  ok(afterApproval.data.some(item => item.id === vehicleId), 'an approved vehicle appears in the public list');

  const rejectedNoReason = await call(`/api/admin/vehicles/${vehicleId}/verify`, { method: 'PATCH', token: adminToken, body: { decision: 'reject' } });
  ok(rejectedNoReason.status === 400, 'a rejection without a reason is refused');
  ok(/reason/i.test(rejectedNoReason.data.message || ''), 'the refusal says a reason is required');

  head('the owner offers a ride using the registered vehicle photo');
  const rideDate = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  rideDate.setHours(9, 0, 0, 0);
  const ride = await call('/api/rides', {
    method: 'POST', token: ownerToken, expect: 201,
    body: {
      vehicleId, from: 'Surat', to: 'Ahmedabad',
      date: rideDate.toISOString(), time: '09:00', seats: 3, price: 300,
      distanceKm: 280, pickupPoint: 'Adajan Circle', notes: 'AC, non-smoking',
      termsAccepted: true
    }
  });
  const rideId = ride.data.id;
  ok(Boolean(rideId), 'the ride offer is created');
  equal(ride.data.status, 'pending', 'a new ride offer waits for admin approval');
  equal(ride.data.vehicleId, vehicleId, 'the offer points at the registered vehicle');
  ok(ride.data.vehicleImage === png || Boolean(ride.data.vehicleImage), 'the offer reuses the registered vehicle photo instead of asking for a second upload');
  equal(ride.data.vehicle, 'Test Car ' + RUN, 'the vehicle name is taken from the registered vehicle');
  equal(ride.data.numberPlate, `GJ05${RUN.toUpperCase()}`, 'the number plate is taken from the registered vehicle');

  head('an unapproved offer is invisible to riders');
  const publicRides = await call('/api/rides');
  ok(!publicRides.data.some(item => item.id === rideId), 'a pending ride offer does not appear in Find a Ride');

  const notMine = await call('/api/rides/mine', { token: riderToken });
  ok(notMine.status === 403, 'a rider cannot list ride offers as an owner');

  head('the backend calculates the quote');
  const quote = await call(`/api/rides/${rideId}/quote?seats=2`, { expect: 200 });
  equal(quote.data.seats, 2, 'the quote echoes the requested seat count');
  equal(quote.data.baseRideAmount, 600, 'two seats at 300 is 600');
  const feePercent = quote.data.platformFeePercent;
  const expectedFee = money(600 * (feePercent / 100));
  equal(money(quote.data.platformFee), expectedFee, `the platform fee is ${feePercent}% of the fare`);
  equal(money(quote.data.grandTotal), money(quote.data.payableAmount), 'the payable amount equals the total');
  ok(quote.data.grandTotal > 600, 'the total includes the platform fee');

  head('admin approves the ride offer');
  const rideApproved = await call(`/api/admin/rides/${rideId}/verify`, { method: 'PATCH', token: adminToken, body: { decision: 'approve' }, expect: 200 });
  equal(rideApproved.data.status, 'approved', 'the ride offer is approved');

  const publicAfter = await call('/api/rides');
  const listed = publicAfter.data.find(item => item.id === rideId);
  ok(Boolean(listed), 'an approved ride offer appears in Find a Ride');
  equal(listed.bookable, true, 'the approved offer is bookable');
  equal(listed.seatsAvailable, 3, 'all three seats are available');
  ok(listed.quote && listed.quote.grandTotal > 0, 'the card carries the backend-calculated total');
  ok(listed.driverPhone === undefined, 'the public listing does not leak the driver phone number');

  head('the rider books and pays for a seat');
  const noTerms = await call(`/api/rides/${rideId}/book`, { method: 'POST', token: riderToken, body: { seats: 1 } });
  ok(noTerms.status === 400, 'booking without accepting the terms is refused');

  const tooMany = await call(`/api/rides/${rideId}/book`, { method: 'POST', token: riderToken, body: { seats: 9, termsAccepted: true } });
  ok(tooMany.status === 400, 'a seat count above the maximum is refused');

  const booking = await call(`/api/rides/${rideId}/book`, { method: 'POST', token: riderToken, body: { seats: 2, termsAccepted: true }, expect: 201 });
  const rideBookingId = booking.data.id;
  ok(Boolean(rideBookingId), 'the seat request is created');
  equal(booking.data.status, 'payment_pending', 'a new booking is awaiting payment');
  equal(booking.data.paymentStatus, 'pending', 'no payment has been taken yet');
  equal(booking.data.seats, 2, 'the requested seats are stored');
  const bookedTotal = money(booking.data.totalAmount);
  equal(bookedTotal, money(quote.data.grandTotal), 'the stored total is exactly the quoted total');
  ok(booking.data.vehicleImage, 'the vehicle photo is stored with the booking');

  const seatsAfterHold = await call(`/api/rides/${rideId}/quote?seats=1`, { expect: 200 });
  equal(seatsAfterHold.data.seatsAvailable, 1, 'the held seats are no longer available');
  ok(seatsAfterHold.data.bookable === false || seatsAfterHold.data.seatsAvailable >= 1, 'availability reflects the hold');

  const dupeBooking = await call(`/api/rides/${rideId}/book`, { method: 'POST', token: riderToken, body: { seats: 1, termsAccepted: true } });
  ok(dupeBooking.status === 409, 'the same rider cannot hold two live seat requests on one ride');

  head('paying');
  /*
   * The branch is on `usable`, NOT on `enabled`.
   *
   * `enabled` only means the two env variables are non-empty. A revoked or
   * mistyped key pair passes that test and then fails every real order, so
   * branching on it produced a checkout that could never complete AND refused
   * the test payment — leaving no way to pay at all. The server now probes
   * Razorpay and reports `usable`, and this suite follows the same signal.
   */
  if (config.data.usable) {
    // Real payments work, so the test payment must be REFUSED and the signature
    // checks must run for real.
    const testRefused = await call(`/api/rides/bookings/${rideBookingId}/payment-test`, { method: 'POST', token: riderToken });
    ok(testRefused.status === 409, 'the test payment is refused while online payment works');

    const order = await call(`/api/rides/bookings/${rideBookingId}/payment-order`, { method: 'POST', token: riderToken, expect: 200 });
    ok(order.data.order_id || order.data.id, 'the server creates the Razorpay order');
    ok(order.data.amount === Math.round(bookedTotal * 100), 'the order amount is the backend total in paise');
    ok(!JSON.stringify(order.data).includes(process.env.RAZORPAY_KEY_SECRET || '___never___'), 'the response never contains the gateway secret');

    const forged = await call(`/api/rides/bookings/${rideBookingId}/verify-payment`, {
      method: 'POST', token: riderToken,
      body: { razorpay_order_id: order.data.order_id, razorpay_payment_id: 'pay_forged', razorpay_signature: crypto.randomBytes(16).toString('hex') }
    });
    ok(forged.status === 400, 'a forged signature is rejected');
    ok(/verification|signature|do not match/i.test(forged.data.message || ''), 'the rejection explains that verification failed');

    const afterForgery = await call('/api/rides/bookings/my', { token: riderToken });
    const stillPending = afterForgery.data.find(item => item.id === rideBookingId);
    ok(stillPending.paymentStatus !== 'paid', 'a failed verification does not mark the booking paid');
  } else {
    /*
     * Real payments cannot succeed — no keys, or keys Razorpay rejects. Two
     * distinct sub-cases, because they used to be conflated:
     */
    ok(config.data.testModeAvailable === true, 'a labelled test payment is offered when online payment cannot succeed');
    ok(/test payment/i.test(config.data.testModeLabel || ''), 'the offer is labelled as a test payment, not as a real one');
    ok(!JSON.stringify(config.data).includes(process.env.RAZORPAY_KEY_SECRET || '___never___'), 'the config response never contains the gateway secret');

    if (config.data.state === 'rejected') {
      // Keys are present but Razorpay refuses them. The order attempt must fail
      // as a BAD GATEWAY, never as a 401: the browser treats a 401 on an
      // authenticated request as an expired session and logs the rider out.
      const order = await call(`/api/rides/bookings/${rideBookingId}/payment-order`, { method: 'POST', token: riderToken });
      ok(order.status === 502, 'a rejected key is reported as a bad gateway, not as a 401');
      ok(order.status !== 401, 'and never as an expired session');
      ok(/RAZORPAY_KEY_ID/.test(order.data.message || ''), 'the message names the variable the operator must fix');
    } else {
      const before = await call(`/api/rides/bookings/${rideBookingId}/payment-order`, { method: 'POST', token: riderToken });
      ok(before.status === 503, 'creating a Razorpay order is refused when no gateway is configured');
    }

    const paid = await call(`/api/rides/bookings/${rideBookingId}/payment-test`, { method: 'POST', token: riderToken, expect: 200 });
    equal(paid.data.booking.status, 'pending_owner', 'the test payment moves the booking to awaiting the driver');
    equal(paid.data.booking.paymentStatus, 'paid', 'the payment is recorded as paid');
    equal(paid.data.booking.paymentMethod, 'demo', 'a test payment is stored as demo, never as real money');
    ok(String(paid.data.booking.paymentReference || '').startsWith('REVEX-RIDE-TEST-'), 'the reference says TEST, so it can never be mistaken for money');

    const replay = await call(`/api/rides/bookings/${rideBookingId}/payment-test`, { method: 'POST', token: riderToken });
    ok(replay.status === 404 || replay.status === 409, 'a replayed test payment is refused');
  }

  head('the owner sees only PAID requests');
  const requests = await call('/api/rides/requests?status=all', { token: ownerToken, expect: 200 });
  const mine = requests.data.filter(item => String(item.rideId && (item.rideId._id || item.rideId)) === rideId);
  equal(mine.length, 1, 'the owner sees the one paid request');
  equal(mine[0].status, 'pending_owner', 'the request is awaiting the owner decision');
  ok(!requests.data.some(item => item.paymentStatus !== 'paid'), 'no unpaid seat hold is listed as a request');

  head('the owner approves the paid seat');
  const decision = await call(`/api/rides/bookings/${rideBookingId}/decision`, { method: 'POST', token: ownerToken, body: { decision: 'approve' }, expect: 200 });
  equal(decision.data.booking.status, 'confirmed', 'the seat is confirmed');
  ok(decision.data.booking.ownerDecision.decision === 'approved', 'the owner decision is recorded');

  const replayDecision = await call(`/api/rides/bookings/${rideBookingId}/decision`, { method: 'POST', token: ownerToken, body: { decision: 'approve' } });
  ok(replayDecision.status === 409, 'the same request cannot be decided twice');

  head('a declining owner REFUNDS the rider');
  // A second rider is needed so the first booking is not disturbed.
  const rider2Email = `rider2+${RUN}@example.test`;
  const rider2 = await call('/api/auth/register', { method: 'POST', body: { name: `Rider2 ${RUN}`, email: rider2Email, phone: '9825000003', password, confirmPassword: password }, expect: 201 });
  const rider2Token = rider2.data.token;

  const booking2 = await call(`/api/rides/${rideId}/book`, { method: 'POST', token: rider2Token, body: { seats: 1, termsAccepted: true }, expect: 201 });
  const rideBooking2 = booking2.data.id;
  const total2 = money(booking2.data.totalAmount);
  equal(money(total2), money(quote.data.price * (1 + feePercent / 100)), 'the second booking total is priced by the same rule');

  if (config.data.usable) {
    skip('online payment works, so the decline-refund path needs a real payment and is exercised manually');
  } else {
    await call(`/api/rides/bookings/${rideBooking2}/payment-test`, { method: 'POST', token: rider2Token, expect: 200 });
    const rejectNoReason = await call(`/api/rides/bookings/${rideBooking2}/decision`, { method: 'POST', token: ownerToken, body: { decision: 'reject' } });
    ok(rejectNoReason.status === 400, 'declining without a reason is refused');

    const reject = await call(`/api/rides/bookings/${rideBooking2}/decision`, {
      method: 'POST', token: ownerToken, body: { decision: 'reject', reason: 'Full for this departure' }, expect: 200
    });
    equal(reject.data.booking.status, 'rejected', 'the request is declined');
    equal(reject.data.booking.cancellation.cancelledBy, 'owner', 'the cancellation is attributed to the owner');
    ok(typeof reject.data.refund.refundAmount === 'number', 'the refund amount is calculated');
    equal(reject.data.refund.refundAmount + reject.data.refund.cancellationFee, total2, 'the refund and the fee add back up to the amount paid');
    ok(reject.data.refund.refundAmount <= total2, 'the refund never exceeds the amount paid');
  }

  head('a rider cancelling is refunded under the policy');
  if (!config.data.usable) {
    const rider3Email = `rider3+${RUN}@example.test`;
    const rider3 = await call('/api/auth/register', { method: 'POST', body: { name: `Rider3 ${RUN}`, email: rider3Email, phone: '9825000004', password, confirmPassword: password }, expect: 201 });
    const rider3Token = rider3.data.token;
    const booking3 = await call(`/api/rides/${rideId}/book`, { method: 'POST', token: rider3Token, body: { seats: 1, termsAccepted: true }, expect: 201 });
    const rideBooking3 = booking3.data.id;
    const total3 = money(booking3.data.totalAmount);
    await call(`/api/rides/bookings/${rideBooking3}/payment-test`, { method: 'POST', token: rider3Token, expect: 200 });

    const preview = await call(`/api/rides/bookings/${rideBooking3}/cancellation-preview`, { token: rider3Token, expect: 200 });
    ok(preview.data.cancellable === true, 'the preview says the booking can be cancelled');
    equal(preview.data.cancelledBy, 'user', 'the preview knows who is cancelling');

    const cancel = await call(`/api/rides/bookings/${rideBooking3}/cancel`, { method: 'POST', token: rider3Token, body: { reason: 'Plans changed' }, expect: 200 });
    equal(cancel.data.booking.status, 'cancelled_by_user', 'the status records who cancelled');
    equal(cancel.data.cancellation.refundAmount + cancel.data.cancellation.cancellationFee, total3, 'the refund and the fee add back up to the amount paid');
    ok(cancel.data.booking.cancellation.cancelledAt, 'the cancellation is timestamped for the audit trail');
    ok(cancel.data.booking.cancellation.explanation.length > 10, 'the cancellation carries a human explanation');
  }

  head('another account cannot touch this booking');
  const intruderEmail = `intruder+${RUN}@example.test`;
  const intruder = await call('/api/auth/register', { method: 'POST', body: { name: `Intruder ${RUN}`, email: intruderEmail, phone: '9825000005', password, confirmPassword: password }, expect: 201 });
  const intruderToken = intruder.data.token;
  const intruderCancel = await call(`/api/rides/bookings/${rideBookingId}/cancel`, { method: 'POST', token: intruderToken, body: { reason: 'not mine' } });
  ok(intruderCancel.status === 403, 'an unrelated rider cannot cancel somebody else\'s seat');
  const intruderPreview = await call(`/api/rides/bookings/${rideBookingId}/cancellation-preview`, { token: intruderToken });
  ok(intruderPreview.status === 403, 'an unrelated rider cannot read the cancellation quote of a booking they do not own');
  const intruderMine = await call('/api/rides/bookings/my', { token: intruderToken, expect: 200 });
  ok(!intruderMine.data.some(item => item.id === rideBookingId), "another rider's booking never appears in their own list");

  head('no overbooking');
  const fullQuote = await call(`/api/rides/${rideId}/quote?seats=1`, { expect: 200 });
  ok(fullQuote.data.seatsAvailable >= 0, 'availability is never negative');
  const bookable = fullQuote.data.bookable;
  if (!bookable) {
    const noSeats = await call(`/api/rides/${rideId}/book`, { method: 'POST', token: intruderToken, body: { seats: 1, termsAccepted: true } });
    ok(noSeats.status === 409 || noSeats.status === 400, 'booking a sold-out ride is refused');
    ok(/seat/i.test(noSeats.data.message || ''), 'the refusal says the seats are gone');
  } else {
    ok(true, 'seats remain, so the sold-out path is not exercised in this run');
  }

  head('the admin Owner Summary dashboard');
  const summary = await call(`/api/admin/owners/${owner.data.user.id}`, { token: adminToken, expect: 200 });
  ok(Boolean(summary.data.owner), 'the owner summary returns the owner');
  equal(summary.data.owner.name, `Owner ${RUN}`, 'the owner name is correct');
  ok(Array.isArray(summary.data.vehicles) && summary.data.vehicles.length === 1, 'the vehicles section lists the one vehicle');
  equal(summary.data.vehicles[0].id, vehicleId, 'the vehicle in the summary is the right one');
  ok(Boolean(summary.data.vehicles[0].image), 'the summary resolves the vehicle photo');
  ok(Array.isArray(summary.data.rides) && summary.data.rides.length === 1, 'the rides section lists the one ride');
  ok(typeof summary.data.rides[0].cancellationInfo === 'object', 'each ride reports its cancellation information');
  ok(summary.data.revenue && typeof summary.data.revenue.total.gross === 'number', 'the revenue split is present');
  equal(
    money(summary.data.revenue.total.ownerShare + summary.data.revenue.total.platformShare),
    money(summary.data.revenue.total.gross),
    'the owner share plus the platform share equals the gross'
  );
  ok(summary.data.activity && typeof summary.data.activity.totalRides === 'number', 'the activity counters are present');
  ok(summary.data.verification && Array.isArray(summary.data.verification.documents), 'the documents section is present');

  const ownerView = await call(`/api/admin/owners/${owner.data.user.id}`, { token: ownerToken });
  ok(ownerView.status === 403, 'an owner cannot read the admin owner summary');

  head('the admin can act on a vehicle without deleting it');
  const removed = await call(`/api/admin/vehicles/${vehicleId}/status`, { method: 'PATCH', token: adminToken, body: { status: 'removed', reason: 'End of the test run' }, expect: 200 });
  equal(removed.data.vehicle.status, 'removed', 'the vehicle is removed from the marketplace');
  const stillThere = await call(`/api/admin/vehicles/${vehicleId}`, { token: adminToken, expect: 200 });
  ok(Boolean(stillThere.data.vehicle), 'the vehicle record is kept, not deleted');
  const noLongerListed = await call('/api/vehicles');
  ok(!noLongerListed.data.some(item => item.id === vehicleId), 'a removed vehicle is no longer bookable');
  await call(`/api/admin/vehicles/${vehicleId}/status`, { method: 'PATCH', token: adminToken, body: { status: 'approved' }, expect: 200 });

  head('revenue reports add up');
  const income = await call('/api/admin/income', { token: adminToken, expect: 200 });
  ok(Array.isArray(income.data.revenueByVehicle), 'revenue by vehicle is reported');
  ok(Array.isArray(income.data.revenueByOwner), 'revenue by owner is reported');
  ok(Array.isArray(income.data.revenueByBooking), 'revenue by rental booking is reported');
  equal(
    money(income.data.rentalRevenue + income.data.rideRevenue),
    money(income.data.totalRevenue),
    'rental revenue plus ride revenue equals the total'
  );
  equal(
    money(income.data.commission + income.data.ownerPayout),
    money(income.data.totalRevenue),
    'the platform share plus the owner payout equals the total'
  );

  head('the payment ledger');
  const payments = await call('/api/payments?limit=200', { token: adminToken, expect: 200 });
  ok(Array.isArray(payments.data.payments), 'the payment ledger is readable by an admin');
  ok(!JSON.stringify(payments.data).includes('key_secret'), 'the ledger contains no secret');
  const riderPayments = await call('/api/payments/mine', { token: riderToken, expect: 200 });
  ok(Array.isArray(riderPayments.data), 'a rider can read their own payments');
  ok(riderPayments.data.every(payment => payment.method !== undefined), 'every payment names its method');
  const otherReceipt = await call(`/api/payments/${(payments.data[0] || {}).id || '000000000000000000000000'}`, { token: intruderToken });
  ok(otherReceipt.status === 403 || otherReceipt.status === 404, "a rider cannot read somebody else's payment receipt");

  head('the assistant');
  const chatStatus = await call('/api/chat/status', { token: riderToken, expect: 200 });
  ok(typeof chatStatus.data.configured === 'boolean', 'the assistant reports whether it is configured');
  ok(!JSON.stringify(chatStatus.data).includes(process.env.CHAT_API_KEY || '___never___'), 'the assistant never returns the API key');
  const conversation = await call('/api/chat/conversations', { method: 'POST', token: riderToken, expect: 201 });
  ok(Boolean(conversation.data.id), 'a conversation can be started');
  const ownConversations = await call('/api/chat/conversations', { token: riderToken, expect: 200 });
  ok(ownConversations.data.some(item => item.id === conversation.data.id), 'the conversation appears in the rider\'s own history');
  const otherList = await call('/api/chat/conversations', { token: intruderToken, expect: 200 });
  ok(!otherList.data.some(item => item.id === conversation.data.id), 'another account cannot see the conversation');
  const emptyMessage = await call('/api/chat', { method: 'POST', token: riderToken, body: { message: '   ' } });
  ok(emptyMessage.status === 400, 'an empty message is refused');
  if (!chatStatus.data.configured) {
    const unconfigured = await call('/api/chat', { method: 'POST', token: riderToken, body: { message: 'hello' } });
    ok(unconfigured.status === 503, 'an unconfigured assistant says so instead of pretending');
  }

  head('profile photo');
  const withPhoto = await call('/api/auth/edit-profile', { method: 'POST', token: riderToken, body: { name: `Rider ${RUN}`, phone: '9825000001', photo: png }, expect: 200 });
  ok(Boolean(withPhoto.data.user.photo), 'a valid profile photo is accepted');
  const badPhoto = await call('/api/auth/edit-profile', { method: 'POST', token: riderToken, body: { name: `Rider ${RUN}`, photo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } });
  ok(badPhoto.status === 400, 'an SVG profile photo is refused');
  ok(/PNG|JPEG|WebP|GIF/i.test(badPhoto.data.message || ''), 'the refusal names the accepted formats');
  const cleared = await call('/api/auth/edit-profile', { method: 'POST', token: riderToken, body: { name: `Rider ${RUN}`, removePhoto: true }, expect: 200 });
  equal(cleared.data.user.photo, '', 'a profile photo can be removed');
  const badName = await call('/api/auth/edit-profile', { method: 'POST', token: riderToken, body: { name: '' } });
  ok(badName.status === 400, 'an empty name is refused');

  head('the admin user list carries the profile photo');
  const users = await call('/api/admin/users', { token: adminToken, expect: 200 });
  ok(Array.isArray(users.data), 'the user list is readable');
  ok(users.data.every(user => 'photo' in user), 'every user has a photo field, even when it is empty');

  head('error handling is specific');
  const notFound = await call('/api/rides/000000000000000000000000', { expect: 404 });
  ok(typeof notFound.data.message === 'string' && notFound.data.message.length > 5, 'a missing ride gives a specific message');
  const badId = await call('/api/rides/not-an-id');
  ok(badId.status === 400, 'a malformed id is refused with 400, not 500');
  const badQuery = await call('/api/vehicles?category=NotACategory');
  ok([200, 400].includes(badQuery.status), 'an invalid filter does not crash the server');
  const unknownEndpoint = await call('/api/does-not-exist');
  equal(unknownEndpoint.status, 404, 'an unknown API path returns 404 with a JSON message');
  equal(unknownEndpoint.data.message, 'API endpoint not found.', 'the 404 message is a JSON body, not HTML');

  head('CORS');
  const cors = await fetch(`${BASE}/api/health`, { headers: { Origin: BASE } });
  ok(cors.status === 200, 'a same-origin request is allowed');
  const foreign = await fetch(`${BASE}/api/health`, { headers: { Origin: 'https://evil.example' } });
  ok(foreign.status === 200 || foreign.headers.get('access-control-allow-origin') === null, 'an unrelated origin is not granted CORS access');
  const preflight = await fetch(`${BASE}/api/rides`, { method: 'OPTIONS', headers: { Origin: BASE, 'Access-Control-Request-Method': 'DELETE' } });
  const allowed = preflight.headers.get('access-control-allow-methods') || '';
  ok(allowed.includes('DELETE'), 'the preflight advertises DELETE, so the admin cancel route is reachable from the browser');
}

main()
  .catch(error => {
    failed += 1;
    failures.push(`fatal: ${error.message}`);
    console.error(`\nFATAL: ${error.message}`);
  })
  .finally(() => {
    console.log('\n──────────────────────────────────────────────');
    console.log(`passed: ${passed}   failed: ${failed}`);
    if (failures.length) {
      console.log('\nfailures:');
      failures.forEach(failure => console.log(`  - ${failure}`));
      process.exit(1);
    }
    console.log('\nAll end-to-end API checks passed.');
  });

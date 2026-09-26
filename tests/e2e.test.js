/**
 * End-to-end regression test against a RUNNING REVEX server.
 * Usage:  node tests/e2e.test.js
 * Requires: the server on http://localhost:5001 and an ADMIN_EMAIL/ADMIN_PASSWORD.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BASE = process.env.REVEX_BASE || require('../scripts/base-url').url;
const ENV_FILE = path.join(__dirname, '..', 'backend', '.env');
const stamp = Date.now();

function loadEnv() {
  try {
    return Object.fromEntries(
      fs.readFileSync(ENV_FILE, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; })
    );
  } catch { return {}; }
}
const ENV = loadEnv();

let passed = 0;
const failures = [];
async function step(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${label}`); }
  catch (error) { failures.push({ label, message: error.message }); console.log(`  FAIL ${label}\n       ${error.message}`); }
}

async function call(pathname, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const ownerEmail = `qa.owner.${stamp}@example.com`;
const userEmail = `qa.user.${stamp}@example.com`;
const password = 'QaPassw0rd!23';
const PLATE = `QA${String(stamp).slice(-6)}`;
let ownerToken, userToken, adminToken, vehicleId, bookingId, agreementId, ratingBookingId;

(async () => {
  console.log(`\nREVEX end-to-end regression — ${BASE}\n`);

  // Preflight: this suite registers several accounts. If auth rate limiting is
  // active from a previous run the suite cannot work, so fail loudly here
  // instead of producing confusing failures further down.
  const probeEmail = `qa.preflight.${stamp}@example.com`;
  const probe = await call('/api/auth/register', { method: 'POST', body: { name: 'Preflight', email: probeEmail, password, confirmPassword: password } });
  if (probe.status === 429) {
    console.error('\nABORTED: the auth rate limiter rejected account creation (HTTP 429).');
    console.error('This suite registers several accounts per run and needs the limit relaxed.');
    console.error('Fix: set AUTH_RATE_LIMIT_MAX=1000 in backend/.env and restart the server.\n');
    process.exit(2);
  }
  if (probe.status !== 201) {
    console.error(`\nABORTED: preflight registration failed (HTTP ${probe.status}): ${JSON.stringify(probe.data)}\n`);
    process.exit(2);
  }

  // ---------------------------------------------------------------- auth
  await step('admin can log in', async () => {
    const r = await call('/api/auth/login', { method: 'POST', body: { email: ENV.ADMIN_EMAIL, password: ENV.ADMIN_PASSWORD } });
    assert.equal(r.status, 200, `login failed: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.user.role, 'admin');
    adminToken = r.data.token;
  });

  await step('owner account registers', async () => {
    const r = await call('/api/auth/register', { method: 'POST', body: { name: 'QA Owner', email: ownerEmail, phone: '9000000001', password, confirmPassword: password, role: 'owner' } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.user.role, 'owner');
  });

  await step('renter account registers', async () => {
    const r = await call('/api/auth/register', { method: 'POST', body: { name: 'QA Renter', email: userEmail, phone: '9000000002', password, confirmPassword: password, role: 'user' } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    userToken = r.data.token;
  });

  await step('duplicate email is rejected with a clear message', async () => {
    const r = await call('/api/auth/register', { method: 'POST', body: { name: 'Dup', email: ownerEmail, phone: '9000000003', password, confirmPassword: password } });
    assert.equal(r.status, 409, `expected 409, got ${r.status}`);
    assert.match(r.data.message, /already exists/i);
  });

  await step('mismatched confirm password is rejected', async () => {
    const r = await call('/api/auth/register', { method: 'POST', body: { name: 'X', email: `qa.x.${stamp}@example.com`, password, confirmPassword: 'different' } });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /do not match/i);
  });

  await step('weak password is rejected', async () => {
    const r = await call('/api/auth/register', { method: 'POST', body: { name: 'X', email: `qa.y.${stamp}@example.com`, password: '123' } });
    assert.equal(r.status, 400);
  });

  await step('owner can log in', async () => {
    const r = await call('/api/auth/login', { method: 'POST', body: { email: ownerEmail, password } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ownerToken = r.data.token;
  });

  await step('login rejects a wrong password', async () => {
    const r = await call('/api/auth/login', { method: 'POST', body: { email: ownerEmail, password: 'wrong-password' } });
    assert.ok(r.status === 401 || r.status === 400, `got ${r.status}`);
  });

  // ------------------------------------------------------------ vehicles
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const doc = 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MKNj';

  await step('owner creates a vehicle with photo, documents and a discount', async () => {
    const r = await call('/api/vehicles', { method: 'POST', token: ownerToken, body: {
      name: 'Toyota Innova Crysta', category: 'Car', brand: 'Toyota', model: 'Innova', location: 'Vesu, Surat',
      fuelType: 'Diesel', transmission: 'Automatic', currentKm: 42000, price: 1200, priceUnit: 'day',
      includedKm: 300, extraKmRate: 12, additionalCharges: 150, discountPercent: 10, taxPercent: 5,
      numberPlate: PLATE, description: 'E2E test vehicle', vehiclePicture: photo,
      documents: [{ type: 'ownership', label: 'RC Book', fileName: 'rc.pdf', mimeType: 'application/pdf', dataUrl: doc }]
    } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    vehicleId = r.data.id;
    assert.ok(vehicleId, 'vehicle id missing');
    assert.equal(r.data.discountPercent, 10, 'discount not persisted');
  });

  await step('duplicate number plate is rejected', async () => {
    const r = await call('/api/vehicles', { method: 'POST', token: ownerToken, body: {
      name: 'Duplicate Plate Car', category: 'Car', location: 'Surat', fuelType: 'Petrol',
      currentKm: 100, price: 500, priceUnit: 'day', numberPlate: PLATE, vehiclePicture: photo
    } });
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.message, /number plate already exists/i);
  });

  await step('out-of-range currentKm is rejected', async () => {
    for (const km of [-1, 70001, 'abc']) {
      const r = await call('/api/vehicles', { method: 'POST', token: ownerToken, body: {
        name: `KM ${km}`, category: 'Car', location: 'Surat', fuelType: 'Petrol',
        currentKm: km, price: 500, priceUnit: 'day', numberPlate: `${PLATE}${String(km).replace(/\W/g, '')}`, vehiclePicture: photo
      } });
      assert.equal(r.status, 400, `km=${km} should be rejected, got ${r.status}`);
      assert.match(r.data.message, /kilometer/i);
    }
  });

  await step('a normal user cannot create a vehicle', async () => {
    const r = await call('/api/vehicles', { method: 'POST', token: userToken, body: {
      name: 'Unauthorized', category: 'Car', location: 'Surat', fuelType: 'Petrol', currentKm: 1,
      price: 100, priceUnit: 'day', numberPlate: `X${String(stamp).slice(-5)}`, vehiclePicture: photo
    } });
    assert.ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}`);
  });

  await step('a normal user cannot reach admin endpoints', async () => {
    for (const p of ['/api/admin/summary', '/api/admin/owners', '/api/admin/agreements', '/api/admin/vehicles?status=all']) {
      const r = await call(p, { token: userToken });
      assert.ok([401, 403].includes(r.status), `${p} should be forbidden, got ${r.status}`);
    }
  });

  await step('owner can read back their own documents', async () => {
    const r = await call(`/api/vehicles/${vehicleId}`, { token: ownerToken });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok((r.data.vehicle?.documents || r.data.documents || []).length > 0, 'owner cannot see own documents');
  });

  await step('new vehicle is pending and hidden from public search', async () => {
    const mine = await call('/api/vehicles/mine', { token: ownerToken });
    const v = (mine.data.vehicles || mine.data || []).find(x => x.id === vehicleId);
    assert.equal(v.status, 'pending');
    const pub = await call('/api/vehicles?status=approved');
    const list = pub.data.vehicles || pub.data || [];
    assert.ok(!list.some(x => x.id === vehicleId), 'pending vehicle is publicly listed');
  });
  // ------------------------------------------------------------ approval
  await step('admin approves the vehicle', async () => {
    const r = await call(`/api/admin/vehicles/${vehicleId}/verify`, { method: 'PATCH', token: adminToken, body: { decision: 'approve' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  });

  await step('rejected vehicles do not stay pending', async () => {
    const r = await call('/api/vehicles', { method: 'POST', token: ownerToken, body: {
      name: 'Reject Target', category: 'Bike', location: 'Surat', fuelType: 'Petrol', currentKm: 500,
      price: 200, priceUnit: 'day', numberPlate: `RJ${String(stamp).slice(-6)}`, vehiclePicture: photo
    } });
    const id = r.data.id;
    const rej = await call(`/api/admin/vehicles/${id}/verify`, { method: 'PATCH', token: adminToken, body: { decision: 'reject', reason: 'Documents illegible' } });
    assert.equal(rej.status, 200, JSON.stringify(rej.data));
    const after = await call('/api/vehicles/mine', { token: ownerToken });
    const v = (after.data.vehicles || after.data || []).find(x => x.id === id);
    assert.equal(v.status, 'rejected', `expected rejected, got ${v.status}`);
  });

  await step('vehicle is now publicly listed with its image', async () => {
    const r = await call('/api/vehicles?status=approved');
    const list = r.data.vehicles || r.data || [];
    const v = list.find(x => x.id === vehicleId);
    assert.ok(v, 'approved vehicle not listed');
    assert.ok(v.image, 'vehicle image missing');
    assert.ok(!/undefined|null/.test(v.image), `bad image url: ${v.image}`);
  });

  // ------------------------------------------------------------- booking
  const start = new Date(Date.now() + 3 * 86400000).toISOString();
  const end = new Date(Date.now() + 5 * 86400000).toISOString();

  await step('owner cannot book their own vehicle', async () => {
    const r = await call('/api/bookings', { method: 'POST', token: ownerToken, body: {
      vehicleId, startDate: start, endDate: end, estimatedKm: 100, panNumber: 'ABCDE1234F',
      drivingLicenseNumber: 'DL1234', agreementAccepted: true
    } });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.message, /own vehicle/i);
  });

  await step('booking is rejected when the agreement is not accepted', async () => {
    const r = await call('/api/bookings', { method: 'POST', token: userToken, body: {
      vehicleId, startDate: start, endDate: end, estimatedKm: 100, agreementAccepted: false
    } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.match(r.data.message, /agreement|terms/i);
  });

  await step('renter books with agreement accepted and a server quote', async () => {
    const r = await call('/api/bookings', { method: 'POST', token: userToken, body: {
      vehicleId, startDate: start, endDate: end, estimatedKm: 400, panNumber: 'ABCDE1234F',
      drivingLicenseNumber: 'DL1234', agreementAccepted: true
    } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    bookingId = r.data.booking?.id || r.data.id;
    const q = r.data.booking?.quote || r.data.quote;
    assert.equal(q.baseRentalAmount, 2400, 'base should be 2 days x 1200');
    assert.equal(q.extraKm, 100);
    assert.equal(q.extraKilometerCharges, 1200);
    assert.equal(q.additionalCharges, 150);
    assert.equal(q.subtotal, 3750);
    assert.equal(q.discountAmount, 375, '10% discount on 3750');
    assert.equal(q.discountedSubtotal, 3375);
    assert.equal(q.taxFees, 168.75, '5% tax on discounted subtotal');
    assert.equal(q.grandTotal, 3543.75);
  });

  await step('agreement record is created and readable by the renter', async () => {
    const r = await call(`/api/bookings/${bookingId}/agreement/details`, { token: userToken });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.agreementId, 'agreementId missing');
    assert.equal(r.data.booking.quote.grandTotal, 3543.75);
    agreementId = r.data.agreementId;
  });

  await step('a third party cannot read the agreement', async () => {
    const outsider = await call('/api/auth/register', { method: 'POST', body: { name: 'Outsider', email: `qa.out.${stamp}@example.com`, password, confirmPassword: password } });
    assert.ok(outsider.data.token, `outsider registration failed: ${JSON.stringify(outsider.data)}`);
    const o = await call(`/api/bookings/${bookingId}/agreement/details`, { token: outsider.data.token });
    assert.equal(o.status, 403, `expected 403 for an unrelated user, got ${o.status}`);
  });

  await step('renter pays and booking moves to pending_owner', async () => {
    const r = await call(`/api/bookings/${bookingId}/payment-demo`, { method: 'POST', token: userToken, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.booking.status, 'pending_owner');
    assert.equal(r.data.booking.paymentStatus, 'paid');
  });

  await step('owner sees the booking request in their inbox', async () => {
    const r = await call('/api/bookings/owner/requests', { token: ownerToken });
    const list = r.data.requests || r.data || [];
    assert.ok(list.some(b => b.id === bookingId), 'booking request not visible to owner');
  });

  await step('owner approves the request', async () => {
    const r = await call(`/api/bookings/${bookingId}/owner-decision`, { method: 'POST', token: ownerToken, body: { decision: 'approve' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.booking.status, 'confirmed');
  });

  // ------------------------------------------------- admin agreement view
  await step('ADMIN AGREEMENTS: the real agreement is listed', async () => {
    const r = await call('/api/admin/agreements', { token: adminToken });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const found = r.data.agreements.find(a => a.bookingId === bookingId);
    assert.ok(found, `agreement for booking ${bookingId} not listed`);
    assert.equal(found.agreementId, agreementId);
    assert.equal(found.vehicle.name, 'Toyota Innova Crysta');
    assert.equal(found.vehicle.numberPlate, PLATE);
    assert.ok(found.renter.email, 'renter missing');
    assert.ok(found.owner.name, 'owner missing');
    assert.equal(found.grandTotal, 3543.75);
    assert.equal(found.discountAmount, 375);
    assert.equal(found.booking.paidAmount, 3543.75);
    assert.equal(found.booking.remainingAmount, 0);
  });

  await step('ADMIN AGREEMENTS: single agreement endpoint works', async () => {
    const list = await call('/api/admin/agreements', { token: adminToken });
    const target = list.data.agreements.find(a => a.bookingId === bookingId);
    const r = await call(`/api/admin/agreements/${target.id}`, { token: adminToken });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.bookingId, bookingId);
  });

  await step('ADMIN AGREEMENTS: search filters server-side', async () => {
    const r = await call(`/api/admin/agreements?search=${encodeURIComponent('Innova')}`, { token: adminToken });
    assert.equal(r.status, 200);
    assert.ok(r.data.agreements.some(a => a.vehicle.name.includes('Innova')));
  });

  await step('agreement PDF downloads and is a valid PDF', async () => {
    const r = await call(`/api/bookings/${bookingId}/agreement`, { token: adminToken, raw: true });
    assert.equal(r.status, 200);
    assert.equal(r.buffer.slice(0, 5).toString(), '%PDF-', 'not a PDF');
    assert.ok(r.buffer.includes(Buffer.from('%%EOF')), 'PDF not terminated');
  });

  // ------------------------------------------------------------ earnings
  await step('owner summary counts the confirmed booking', async () => {
    const r = await call('/api/bookings/owner/summary', { token: ownerToken });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const s = r.data.summary || r.data;
    assert.ok(s.totalBookings >= 1, 'booking not counted');
    assert.ok(s.totalEarnings > 0, 'earnings not credited');
  });

  await step('cancelling a confirmed paid booking REVERSES owner earnings', async () => {
    const before = await call('/api/bookings/owner/summary', { token: ownerToken });
    const beforeTotal = (before.data.summary || before.data).totalEarnings;

    const cancel = await call(`/api/bookings/${bookingId}/cancel`, { method: 'POST', token: userToken });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.data));

    const after = await call('/api/bookings/owner/summary', { token: ownerToken });
    const afterTotal = (after.data.summary || after.data).totalEarnings;
    assert.ok(afterTotal < beforeTotal, `earnings were not reversed (${beforeTotal} -> ${afterTotal})`);
  });

  // -------------------------------------------------------------- ratings
  await step('renter can rate a completed rental', async () => {
    const r = await call('/api/bookings', { method: 'POST', token: userToken, body: {
      vehicleId, startDate: start, endDate: end, estimatedKm: 100, panNumber: 'ABCDE1234F',
      drivingLicenseNumber: 'DL1234', agreementAccepted: true
    } });
    const id = r.data.booking?.id || r.data.id;
    assert.ok(id, `second booking failed: ${JSON.stringify(r.data)}`);
    ratingBookingId = id;
  });

  // ------------------------------------------------------- forgot password
  await step('forgot-password does not leak whether an email exists', async () => {
    const known = await call('/api/auth/forgot-password', { method: 'POST', body: { email: userEmail } });
    const unknown = await call('/api/auth/forgot-password', { method: 'POST', body: { email: `qa.nobody.${stamp}@example.com` } });
    assert.equal(known.data.message, unknown.data.message, 'response differs for known vs unknown email');
  });

  await step('reset-password rejects a mismatched confirmation', async () => {
    const r = await call('/api/auth/reset-password', { method: 'POST', body: { token: 'x'.repeat(64), newPassword: 'NewPassw0rd!1', confirmPassword: 'OtherPass1!' } });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /do not match/i);
  });

  await step('reset-password rejects an invalid token', async () => {
    const r = await call('/api/auth/reset-password', { method: 'POST', body: { token: 'f'.repeat(64), newPassword: 'NewPassw0rd!1', confirmPassword: 'NewPassw0rd!1' } });
    assert.equal(r.status, 400, `got ${r.status}`);
  });

  await step('ADMIN OWNER SUMMARY: detail panel returns real statistics', async () => {
    const list = await call('/api/admin/owners', { token: adminToken });
    const owners = list.data.owners || list.data || [];
    const target = owners.find(o => o.email === ownerEmail);
    assert.ok(target, 'QA owner missing from /api/admin/owners');
    const r = await call(`/api/admin/owners/${target.id || target._id}`, { token: adminToken });
    assert.equal(r.status, 200, `owner detail failed: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.owner.email, ownerEmail);
    for (const key of ['totalVehicles', 'approvedVehicles', 'pendingVehicles', 'rejectedVehicles', 'totalBookings', 'pendingBookings', 'activeBookings', 'completedBookings', 'cancelledBookings', 'rejectedBookings', 'totalEarnings']) {
      assert.ok(key in r.data.totals, `missing stat: ${key}`);
    }
    assert.ok(Array.isArray(r.data.vehicles) && r.data.vehicles.length >= 1, 'no vehicles in owner summary');
  });

  await step('owner A never sees owner B data', async () => {
    const other = await call('/api/auth/register', { method: 'POST', body: { name: 'Other Owner', email: `qa.owner2.${stamp}@example.com`, password, confirmPassword: password, role: 'owner' } });
    const t2 = other.data.token;
    await call('/api/vehicles', { method: 'POST', token: t2, body: {
      name: 'Other Owner Car', category: 'Car', location: 'Rajkot', fuelType: 'CNG', currentKm: 1000,
      price: 700, priceUnit: 'day', numberPlate: `OT${String(stamp).slice(-6)}`, vehiclePicture: photo
    } });
    const mine = await call('/api/bookings/owner/summary', { token: ownerToken });
    const mineNames = (mine.data.vehicles || []).map(v => v.name);
    assert.ok(!mineNames.includes('Other Owner Car'), 'owner A sees owner B vehicles');
  });

  // ------------------------------------------------------------- cleanup
  await step('cleanup: remove test vehicles', async () => {
    const r = await call(`/api/admin/vehicles/${vehicleId}`, { method: 'DELETE', token: adminToken, body: { reason: 'QA cleanup', confirm: true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  });

  console.log(`\n${'-'.repeat(58)}`);
  console.log(`PASSED: ${passed}    FAILED: ${failures.length}`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.label}: ${f.message}`);
    process.exit(1);
  }
  console.log('All end-to-end regression checks passed.');
})().catch(error => { console.error('\nFATAL:', error); process.exit(1); });

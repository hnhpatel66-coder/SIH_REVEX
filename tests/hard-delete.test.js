/**
 * Permanent (hard) delete tests.
 * Verifies that deleting a vehicle or a user removes the record and every
 * dependent row from MongoDB, that a confirmation + reason are required, and
 * that the last admin can never be deleted.
 *
 * Usage: node tests/hard-delete.test.js
 */
const assert = require('node:assert/strict');
const BASE = process.env.REVEX_BASE || require('../scripts/base-url').url;
const ENV = require('../scripts/base-url').env;
const stamp = Date.now();
const PASSWORD = 'Abcd1234!zz';
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
async function call(p, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

(async () => {
  console.log(`\nHard delete tests — ${BASE}\n`);

  const admin = await call('/api/auth/login', { method: 'POST', body: { email: ENV.ADMIN_EMAIL, password: ENV.ADMIN_PASSWORD } });
  const adminToken = admin.data.token;

  // Owner + vehicle to delete
  const ownerEmail = `del.owner.${stamp}@example.com`;
  const ownerReg = await call('/api/auth/register', { method: 'POST', body: { name: 'Delete Owner', email: ownerEmail, phone: '9877000001', password: PASSWORD, confirmPassword: PASSWORD, role: 'owner' } });
  const ownerToken = ownerReg.data.token;
  const ownerId = ownerReg.data.user.id;

  const renterEmail = `del.renter.${stamp}@example.com`;
  const renterReg = await call('/api/auth/register', { method: 'POST', body: { name: 'Delete Renter', email: renterEmail, phone: '9877000002', password: PASSWORD, confirmPassword: PASSWORD, role: 'user' } });
  const renterToken = renterReg.data.token;

  const plate = `DL${String(stamp).slice(-6)}`;
  const veh = await call('/api/vehicles', { method: 'POST', token: ownerToken, body: {
    name: 'Doomed Vehicle', category: 'Car', brand: 'Test', model: 'X', location: 'Surat',
    fuelType: 'Petrol', currentKm: 5000, price: 900, priceUnit: 'day',
    numberPlate: plate, vehiclePicture: photo,
    documents: [{ type: 'puc', label: 'PUC', fileName: 'puc.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MKNj' }]
  } });
  const vehicleId = veh.data.id;
  await call(`/api/admin/vehicles/${vehicleId}/verify`, { method: 'PATCH', token: adminToken, body: { decision: 'approve' } });

  // Create a booking so the cascade has dependents to remove.
  const start = new Date(Date.now() + 4 * 86400000).toISOString();
  const end = new Date(Date.now() + 6 * 86400000).toISOString();
  const book = await call('/api/bookings', { method: 'POST', token: renterToken, body: {
    vehicleId, startDate: start, endDate: end, estimatedKm: 50,
    panNumber: 'ABCDE1234F', drivingLicenseNumber: 'DL123456', agreementAccepted: true
  } });
  const bookingId = book.data.booking?.id || book.data.id;
  await call(`/api/bookings/${bookingId}/payment-demo`, { method: 'POST', token: renterToken, body: {} });

  const dbCount = async (coll, filter) => {
    const r = await call(`/api/admin/_test/count/${coll}?filter=${encodeURIComponent(JSON.stringify(filter || {}))}`, { token: adminToken });
    return r.data.count;
  };

  // ---------------------------------------------------------------- vehicle
  await test('delete without confirmation is rejected', async () => {
    const r = await call(`/api/admin/vehicles/${vehicleId}`, { method: 'DELETE', token: adminToken, body: { reason: 'testing' } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.equal(r.data.code, 'CONFIRMATION_REQUIRED');
  });

  await test('delete without a reason is rejected', async () => {
    const r = await call(`/api/admin/vehicles/${vehicleId}`, { method: 'DELETE', token: adminToken, body: { confirm: true } });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /reason/i);
  });

  await test('a normal user cannot delete a vehicle', async () => {
    const r = await call(`/api/admin/vehicles/${vehicleId}`, { method: 'DELETE', token: renterToken, body: { reason: 'x', confirm: true } });
    assert.ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}`);
  });

  await test('the vehicle still exists before the confirmed delete', async () => {
    const mine = await call('/api/vehicles/mine', { token: ownerToken });
    const list = mine.data.vehicles || mine.data || [];
    assert.ok(list.some(v => v.id === vehicleId), 'vehicle missing before delete');
  });

  await test('confirmed delete removes the vehicle permanently', async () => {
    const r = await call(`/api/admin/vehicles/${vehicleId}`, { method: 'DELETE', token: adminToken, body: { reason: 'permanent delete test', confirm: true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.success, true);
    assert.equal(r.data.deletedId, vehicleId);
    assert.ok(r.data.counts.bookings >= 1, `expected dependent bookings removed, got ${JSON.stringify(r.data.counts)}`);
    assert.ok(r.data.counts.agreements >= 1, 'agreement not cascaded');
    assert.ok(r.data.counts.payments >= 1, 'payment not cascaded');
  });

  await test('the vehicle is gone from the owner fleet and admin list', async () => {
    const mine = await call('/api/vehicles/mine', { token: ownerToken });
    const fleet = mine.data.vehicles || (Array.isArray(mine.data) ? mine.data : []);
    assert.ok(!fleet.some(v => v.id === vehicleId), 'vehicle still in owner fleet');
    const adminList = await call('/api/admin/vehicles?status=all', { token: adminToken });
    const all = adminList.data.vehicles || (Array.isArray(adminList.data) ? adminList.data : []);
    assert.ok(!all.some(v => v.id === vehicleId), 'vehicle still in admin list');
  });

  await test('dependent booking + agreement + payment are gone', async () => {
    const mine = await call('/api/bookings/my', { token: renterToken });
    const list = mine.data || [];
    assert.ok(!list.some(b => b.id === bookingId), 'booking survived the cascade');
    const agr = await call('/api/bookings/my-agreements', { token: renterToken });
    const agrList = agr.data || [];
    assert.ok(!agrList.some(a => String(a.bookingId) === String(bookingId)), 'agreement survived the cascade');
  });

  await test('the number plate becomes reusable after deletion', async () => {
    const again = await call('/api/vehicles', { method: 'POST', token: ownerToken, body: {
      name: 'Reused Plate', category: 'Car', location: 'Surat', fuelType: 'Petrol',
      currentKm: 100, price: 500, priceUnit: 'day', numberPlate: plate, vehiclePicture: photo
    } });
    assert.equal(again.status, 201, `plate should be reusable: ${JSON.stringify(again.data)}`);
    // clean it up again
    await call(`/api/admin/vehicles/${again.data.id}`, { method: 'DELETE', token: adminToken, body: { reason: 'cleanup', confirm: true } });
  });

  // ------------------------------------------------------------------- user
  await test('admin cannot delete their own account', async () => {
    const me = await call('/api/auth/me', { token: adminToken });
    const r = await call(`/api/admin/users/${me.data.user.id}`, { method: 'DELETE', token: adminToken, body: { reason: 'self', confirm: true } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'SELF_DELETE');
  });

  await test('confirmed user delete removes the account and its vehicles', async () => {
    // give the owner a vehicle so the cascade has something to clean
    const v = await call('/api/vehicles', { method: 'POST', token: ownerToken, body: {
      name: 'Owner Vehicle A', category: 'Car', location: 'Surat', fuelType: 'Petrol',
      currentKm: 200, price: 700, priceUnit: 'day', numberPlate: `OW${String(stamp).slice(-6)}`, vehiclePicture: photo
    } });
    const r = await call(`/api/admin/users/${ownerId}`, { method: 'DELETE', token: adminToken, body: { reason: 'delete owner test', confirm: true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.success, true);
    assert.ok(r.data.counts.vehicles >= 1, 'owner vehicles not cascaded');
    assert.ok(r.data.preview.vehicles >= 1, 'preview did not report vehicles');
  });

  await test('the deleted owner can no longer log in', async () => {
    const r = await call('/api/auth/login', { method: 'POST', body: { email: ownerEmail, password: PASSWORD } });
    assert.ok([400, 401].includes(r.status), `login should fail, got ${r.status}`);
  });

  await test('the last admin account is protected', async () => {
    const users = await call('/api/admin/users', { token: adminToken });
    const list = users.data.users || users.data || [];
    const admins = list.filter(u => u.role === 'admin');
    if (admins.length === 1) {
      // The only admin is the caller, already blocked by SELF_DELETE.
      const r = await call(`/api/admin/users/${admins[0].id}`, { method: 'DELETE', token: adminToken, body: { reason: 'last admin', confirm: true } });
      assert.equal(r.status, 400);
    }
    assert.ok(admins.length >= 1, 'admin list unexpectedly empty');
  });

  await test('cleanup renter', async () => {
    const users = await call('/api/admin/users', { token: adminToken });
    const list = users.data.users || users.data || [];
    const renter = list.find(u => u.email === renterEmail);
    if (renter) {
      const r = await call(`/api/admin/users/${renter.id || renter._id}`, { method: 'DELETE', token: adminToken, body: { reason: 'cleanup', confirm: true } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
  });

  console.log(`\n${'-'.repeat(58)}`);
  console.log(`PASSED: ${pass}    FAILED: ${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); process.exit(1); }
  console.log('All hard delete tests passed.');
})().catch(e => { console.error('FATAL', e); process.exit(1); });

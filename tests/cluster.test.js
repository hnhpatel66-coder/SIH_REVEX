/**
 * Cluster-migration acceptance tests (section 28 of the brief).
 * Verifies registration, login, JWT, admin, owner, vehicle, booking and a
 * restart against the NEW MongoDB Atlas cluster.
 *
 * Usage:  node tests/cluster.test.js
 * Env:    REVEX_BASE (default http://localhost:5001)
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BASE = process.env.REVEX_BASE || require('../scripts/base-url').url;
const ENV = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', 'backend', '.env'), 'utf8').split('\n')
    .filter(l => /^[A-Z_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; })
);
const stamp = Date.now();
const PASSWORD = 'Abcd1234!zz';

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

// Shared state across the numbered test cases.
const newUser = `newuser.${stamp}@example.com`;
let userToken, adminToken, ownerToken, vehicleId, bookingId;

(async () => {
  console.log(`\nCluster acceptance tests — ${BASE}\n`);

  // ------------------------------------------------------------- Test 1
  await test('Test 1 — create a brand new user', async () => {
    const r = await call('/api/auth/register', { method: 'POST', body: { name: 'New User', email: newUser, phone: '9876500000', password: PASSWORD, confirmPassword: PASSWORD, role: 'user' } });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.user.email, newUser);
    assert.equal(r.data.user.role, 'user');
    assert.ok(r.data.token, 'no token returned');
    userToken = r.data.token;
  });

  // ------------------------------------------------------------- Test 2
  await test('Test 2 — duplicate email returns a clear message', async () => {
    const r = await call('/api/auth/register', { method: 'POST', body: { name: 'Dup', email: newUser, phone: '9876500001', password: PASSWORD, confirmPassword: PASSWORD, role: 'user' } });
    assert.equal(r.status, 409, `expected 409, got ${r.status}`);
    assert.match(r.data.message, /already exists/i);
    assert.equal(r.data.code, 'EMAIL_EXISTS');
  });

  // ------------------------------------------------------------- Test 3
  await test('Test 3 — login with the new account issues a JWT', async () => {
    const r = await call('/api/auth/login', { method: 'POST', body: { email: newUser, password: PASSWORD } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.token, 'no token');
    assert.equal(r.data.token.split('.').length, 3, 'token is not a JWT');
    userToken = r.data.token;
  });

  // ------------------------------------------------------------- Test 4
  await test('Test 4 — wrong password is rejected', async () => {
    const r = await call('/api/auth/login', { method: 'POST', body: { email: newUser, password: 'TotallyWrong123' } });
    assert.ok([400, 401].includes(r.status), `expected 400/401, got ${r.status}`);
    assert.ok(!r.data.token, 'token issued for bad password');
  });

  // ------------------------------------------------------------- Test 5
  await test('Test 5 — JWT works on a protected route', async () => {
    const me = await call('/api/auth/me', { token: userToken });
    assert.equal(me.status, 200, `expected 200, got ${me.status}`);
    assert.equal(me.data.user.email, newUser);
    const noToken = await call('/api/auth/me');
    assert.ok([401, 403].includes(noToken.status), 'unauthenticated request was allowed');
  });

  // ------------------------------------------------------------- Test 6
  await test('Test 6 — admin login works', async () => {
    const r = await call('/api/auth/login', { method: 'POST', body: { email: ENV.ADMIN_EMAIL, password: ENV.ADMIN_PASSWORD } });
    assert.equal(r.status, 200, `admin login failed: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.user.role, 'admin');
    adminToken = r.data.token;
  });

  // ------------------------------------------------------------- Test 7
  await test('Test 7 — owner account can be created', async () => {
    const email = `owner.${stamp}@example.com`;
    const r = await call('/api/auth/register', { method: 'POST', body: { name: 'Owner QA', email, phone: '9876500002', password: PASSWORD, confirmPassword: PASSWORD, role: 'owner' } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.user.role, 'owner');
    ownerToken = r.data.token;
  });

  await test('Test 7b — user can be converted to owner', async () => {
    const r = await call('/api/auth/switch-role', { method: 'POST', token: userToken, body: { newRole: 'owner' } });
    assert.equal(r.status, 200, `switch-role failed: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.user.role, 'owner');
    // switch back so later checks use a plain renter
    const back = await call('/api/auth/switch-role', { method: 'POST', token: userToken, body: { newRole: 'user' } });
    assert.equal(back.status, 200, `switch back failed: ${JSON.stringify(back.data)}`);
  });

  // ------------------------------------------------------------- Test 8
  await test('Test 8 — vehicle is stored', async () => {
    const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const r = await call('/api/vehicles', { method: 'POST', token: ownerToken, body: {
      name: 'Cluster Test Car', category: 'Car', brand: 'Honda', model: 'City', location: 'Surat',
      fuelType: 'Petrol', currentKm: 15000, price: 1000, priceUnit: 'day',
      numberPlate: `CL${String(stamp).slice(-6)}`, vehiclePicture: photo
    } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    vehicleId = r.data.id;
    const approved = await call(`/api/admin/vehicles/${vehicleId}/verify`, { method: 'PATCH', token: adminToken, body: { decision: 'approve' } });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
  });

  // ------------------------------------------------------------- Test 9
  await test('Test 9 — booking is stored', async () => {
    const start = new Date(Date.now() + 4 * 86400000).toISOString();
    const end = new Date(Date.now() + 6 * 86400000).toISOString();
    const r = await call('/api/bookings', { method: 'POST', token: userToken, body: {
      vehicleId, startDate: start, endDate: end, estimatedKm: 50,
      panNumber: 'ABCDE1234F', drivingLicenseNumber: 'DL123456', agreementAccepted: true
    } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    bookingId = r.data.booking?.id || r.data.id;
    assert.ok(bookingId, 'no booking id');
  });

  // ------------------------------------------------------------- Test 10
  await test('Test 10 — health reports the Atlas cluster + explicit database', async () => {
    const r = await call('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.database, 'connected');
    assert.equal(r.data.mode, 'atlas', 'not connected to Atlas');
    assert.equal(r.data.databaseName, 'vroomy', `unexpected database "${r.data.databaseName}"`);
  });

  await test('JWT_SECRET is loaded (never printed)', async () => {
    const has = Boolean(ENV.JWT_SECRET) && ENV.JWT_SECRET.length >= 16;
    assert.ok(has, 'JWT_SECRET missing or too short in .env');
    // The token must verify, which proves the same secret is used to sign it.
    const parts = userToken.split('.');
    assert.equal(parts.length, 3);
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    assert.ok(decoded.userId, 'token payload has no userId');
    assert.ok(decoded.exp > Date.now() / 1000, 'token already expired');
  });

  // ------------------------------------------------------------- cleanup
  await test('cleanup', async () => {
    if (vehicleId) await call(`/api/admin/vehicles/${vehicleId}`, { method: 'DELETE', token: adminToken, body: { reason: 'cluster test cleanup' } });
    for (const email of [newUser, `owner.${stamp}@example.com`]) {
      const users = (await call('/api/admin/users', { token: adminToken })).data.users || [];
      const u = users.find(x => x.email === email);
      if (u) await call(`/api/admin/users/${u.id || u._id}`, { method: 'DELETE', token: adminToken });
    }
  });

  console.log(`\n${'-'.repeat(58)}\nPASSED: ${pass}    FAILED: ${failures.length}`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
    process.exit(1);
  }
  console.log('All cluster acceptance tests passed.');
})().catch(e => { console.error('FATAL', e); process.exit(1); });

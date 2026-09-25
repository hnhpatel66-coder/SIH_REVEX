// Verifies the public vehicle search filters (category, fuel, price, location)
// and the image pipeline across listing + details.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BASE = process.env.REVEX_BASE || require('../scripts/base-url').url;
const ENV = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', 'backend', '.env'), 'utf8').split('\n')
    .filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; })
);
const stamp = Date.now();
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function call(p, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let d = {}; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  return { status: r.status, data: d };
}

let pass = 0, fail = 0;
async function step(label, fn) {
  try { await fn(); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.log(`  FAIL ${label}\n       ${e.message}`); }
}

(async () => {
  console.log(`\nVehicle search / image pipeline — ${BASE}\n`);

  const admin = await call('/api/auth/login', { method: 'POST', body: { email: ENV.ADMIN_EMAIL, password: ENV.ADMIN_PASSWORD } });
  const adminToken = admin.data.token;

  const spec = [
    { name: 'Filter Test Car', category: 'Car', fuelType: 'Petrol', price: 800, plate: `CA${String(stamp).slice(-6)}` },
    { name: 'Filter Test Bike', category: 'Bike', fuelType: 'Electric', price: 300, plate: `BI${String(stamp).slice(-6)}` },
    { name: 'Filter Test Scooter', category: 'Scooter', fuelType: 'CNG', price: 200, plate: `SC${String(stamp).slice(-6)}` }
  ];
  const ids = [];
  for (const v of spec) {
    const r = await call('/api/vehicles', { method: 'POST', token: adminToken, body: {
      name: v.name, category: v.category, brand: 'TestBrand', model: 'M1', location: 'FilterTown',
      fuelType: v.fuelType, currentKm: 1000, price: v.price, priceUnit: 'day',
      numberPlate: v.plate, vehiclePicture: photo
    } });
    assert.ok(r.data.id, `create failed for ${v.name}: ${JSON.stringify(r.data)}`);
    ids.push(r.data.id);
  }
  for (const id of ids) {
    const r = await call(`/api/admin/vehicles/${id}/verify`, { method: 'PATCH', token: adminToken, body: { decision: 'approve' } });
    assert.equal(r.status, 200);
  }

  const get = async q => {
    const r = await call(`/api/vehicles?${q}`);
    const list = r.data.vehicles || r.data || [];
    return list.filter(v => spec.some(s => v.name === s.name));
  };

  await step('category filter returns only that category', async () => {
    const cars = await get('category=Car');
    assert.ok(cars.length >= 1, 'no cars returned');
    assert.ok(cars.every(v => v.category === 'Car'), 'non-car leaked into Car filter');
  });
  await step('bike filter works', async () => {
    const bikes = await get('category=Bike');
    assert.ok(bikes.every(v => v.category === 'Bike'), 'non-bike leaked');
  });
  await step('scooter filter works', async () => {
    const s = await get('category=Scooter');
    assert.ok(s.every(v => v.category === 'Scooter'), 'non-scooter leaked');
  });
  await step('fuel filter works', async () => {
    const ev = await get('fuelType=Electric');
    assert.ok(ev.length >= 1 && ev.every(v => v.fuelType === 'Electric'), 'fuel filter wrong');
  });
  await step('location filter works', async () => {
    const loc = await get('location=FilterTown');
    assert.ok(loc.length >= 3, `expected >=3 in FilterTown, got ${loc.length}`);
  });
  await step('maxPrice filter works', async () => {
    const cheap = await get('maxPrice=250');
    assert.ok(cheap.every(v => Number(v.price) <= 250), 'maxPrice filter leaked');
  });
  await step('images are present and well formed on cards', async () => {
    const all = await get('location=FilterTown');
    for (const v of all) {
      assert.ok(v.image, `${v.name} has no image`);
      assert.ok(/^(data:image\/|https?:\/\/|\/uploads\/|\/images\/|\/assets\/)/.test(v.image), `bad image url on ${v.name}: ${v.image}`);
      assert.ok(!v.image.includes('localhost:5001/http'), `double-prefixed url on ${v.name}`);
    }
  });
  await step('vehicle detail endpoint returns full record', async () => {
    const all = await get('location=FilterTown');
    const v = all[0];
    const r = await call(`/api/vehicles/${v.id}`);
    assert.equal(r.status, 200);
    const d = r.data.vehicle || r.data;
    for (const k of ['name', 'category', 'fuelType', 'price', 'image']) {
      assert.ok(d[k] !== undefined && d[k] !== null && d[k] !== '', `detail missing ${k}`);
    }
  });
  await step('public listing hides owner earnings and private fields', async () => {
    const all = await get('location=FilterTown');
    const v = all[0];
    assert.equal(v.totalEarnings, undefined, 'totalEarnings leaked publicly');
    assert.equal(v.totalRentals, undefined, 'totalRentals leaked publicly');
    assert.equal(v.documents, undefined, 'documents leaked publicly');
  });
  await step('permanently deleted vehicle disappears from public search', async () => {
    const r = await call(`/api/admin/vehicles/${ids[0]}`, { method: 'DELETE', token: adminToken, body: { reason: 'filter cleanup', confirm: true } });
    assert.equal(r.status, 200, `hard delete failed: ${JSON.stringify(r.data)}`);
    const all = await get('location=FilterTown');
    assert.ok(!all.some(v => v.id === ids[0]), 'deleted vehicle still listed');
  });

  for (const id of ids.slice(1)) {
    await call(`/api/admin/vehicles/${id}`, { method: 'DELETE', token: adminToken, body: { reason: 'filter cleanup', confirm: true } });
  }

  console.log(`\nPASSED: ${pass}  FAILED: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

// Date-aware availability checks for the renter portal.
const assert = require('node:assert/strict');
const BASE = process.env.REVEX_BASE || require('../scripts/base-url').url;

let pass = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
async function list(qs) {
  const r = await fetch(`${BASE}/api/vehicles?${qs}`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  return r.json();
}

(async () => {
  console.log(`\nRenter availability — ${BASE}\n`);

  const all = await list('includeUpcoming=true');
  if (!all.length) {
    console.log('  No approved vehicles exist; nothing to verify.');
    process.exit(0);
  }
  const future = all.filter(v => v.availableFrom && new Date(v.availableFrom) > new Date());
  const anytime = all.filter(v => !v.availableFrom || new Date(v.availableFrom) <= new Date());

  console.log(`  approved vehicles: ${all.length} (${anytime.length} free now, ${future.length} scheduled for later)\n`);

  await test('vehicles free now are listed without dates', async () => {
    const rows = await list('status=approved');
    assert.equal(rows.length, anytime.length, `expected ${anytime.length}, got ${rows.length}`);
  });

  await test('a vehicle with a future availableFrom is hidden for a date before it', async () => {
    for (const v of future) {
      const dayBefore = new Date(new Date(v.availableFrom).getTime() - 86400000).toISOString().slice(0, 10);
      const rows = await list(`status=approved&startDate=${dayBefore}&endDate=${dayBefore}`);
      assert.ok(!rows.some(r => r.id === v.id), `${v.name} leaked for ${dayBefore}`);
    }
  });

  await test('a vehicle with a future availableFrom appears on its available date', async () => {
    for (const v of future) {
      const day = new Date(v.availableFrom).toISOString().slice(0, 10);
      const end = new Date(new Date(v.availableFrom).getTime() + 2 * 86400000).toISOString().slice(0, 10);
      const rows = await list(`status=approved&startDate=${day}&endDate=${end}`);
      assert.ok(rows.some(r => r.id === v.id), `${v.name} missing for ${day}`);
    }
  });

  await test('includeUpcoming lists everything approved regardless of date', async () => {
    const rows = await list('includeUpcoming=true');
    assert.equal(rows.length, all.length);
  });

  await test('sort=available_soon puts the earliest date first', async () => {
    const rows = await list('includeUpcoming=true&sort=available_soon');
    const dated = rows.filter(v => v.availableFrom);
    for (let i = 1; i < dated.length; i++) {
      assert.ok(
        new Date(dated[i - 1].availableFrom) <= new Date(dated[i].availableFrom),
        `out of order at index ${i}`
      );
    }
  });

  await test('sort=price_asc returns ascending prices', async () => {
    const rows = await list('includeUpcoming=true&sort=price_asc');
    for (let i = 1; i < rows.length; i++) {
      assert.ok(Number(rows[i - 1].price) <= Number(rows[i].price), `out of order at index ${i}`);
    }
  });

  await test('other filters still work alongside the date window', async () => {
    const rows = await list('includeUpcoming=true&category=Car');
    assert.ok(rows.every(v => ['Car'].includes(v.category || v.type)), 'category filter leaked');
  });

  await test('the renter search page exposes date and sort controls', async () => {
    const html = await (await fetch(`${BASE}/rental.html`)).text();
    for (const id of ['rentalStart', 'rentalEnd', 'rentalSort', 'rentalAvailabilityNote']) {
      assert.ok(html.includes(id), `rental.html is missing #${id}`);
    }
  });

  console.log(`\n${'-'.repeat(58)}`);
  console.log(`PASSED: ${pass}    FAILED: ${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); process.exit(1); }
  console.log('All renter availability checks passed.');
})().catch(e => { console.error('FATAL', e); process.exit(1); });

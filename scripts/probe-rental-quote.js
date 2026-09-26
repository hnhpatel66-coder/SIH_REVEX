/**
 * Reproduce the rental-quote failure with a throwaway vehicle and the exact
 * window from the bug report.
 *   node scripts/probe-rental-quote.js
 */
'use strict';

const BASE = 'http://localhost:5001/api';
let token = '';

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  // The admin can list a vehicle too, so the probe never has to touch - or
  // depend on - whatever owner accounts currently exist.
  const admin = await call('/auth/login', { method: 'POST', auth: false, body: { email: 'admin@vroomy.com', password: 'Admin@12345' } });
  token = admin.data.token;
  console.log('admin signed in:', Boolean(token), admin.data.message || '');
  if (!token) return;

  // A vehicle like the one in the report: per-day pricing, available from yesterday.
  const created = await call('/vehicles', {
    method: 'POST',
    body: {
      name: 'MG Gloster', brand: 'MG', model: 'Gloster', category: 'Car', fuelType: 'Petrol',
      transmission: 'Manual', location: 'Anand', price: 2400, priceUnit: 'day',
      numberPlate: 'GJ01AB1234', currentKm: 17634, availableFrom: new Date(Date.now() - 86400000).toISOString()
    }
  });
  console.log('vehicle created:', created.status, created.data.id || created.data.message);
  if (!created.data.id) return;
  const id = created.data.id;

  // Approve it so it is publicly bookable.
  const approve = await call(`/admin/vehicles/${id}/status`, {
    method: 'PATCH',
    body: { status: 'approved' }
  });
  console.log('approved       :', approve.status, approve.data.message || '');

  const cases = [
    ['28-09 05:45 -> 30-09 00:00  (the reported window)', '2026-09-28T05:45', '2026-09-30T00:00', 452],
    ['28-09 10:00 -> 30-09 10:00', '2026-09-28T10:00', '2026-09-30T10:00', 452],
    ['28-09 10:00 -> 28-09 12:00', '2026-09-28T10:00', '2026-09-28T12:00', 10],
    ['28-09 10:00 -> 29-09 10:00', '2026-09-28T10:00', '2026-09-29T10:00', 10]
  ];
  console.log('\n=== GET /vehicles/:id/quote ===');
  for (const [label, startDate, endDate, km] of cases) {
    const q = await call(`/vehicles/${id}/quote?startDate=${startDate}&endDate=${endDate}&estimatedKm=${km}`);
    console.log(`  ${q.status}  ${label}`);
    if (q.status !== 200) console.log(`        -> "${q.data.message}"`);
    else console.log(`        total ${q.data.grandTotal}  (${q.data.durationLabel})`);
  }

  console.log('\n=== the client-side fallback (what the form uses when the api fails) ===');
  const src = require('fs').readFileSync('js/rental.js', 'utf8');
  const fn = /function calculateClientQuote\(([\s\S]*?)\n\}/.exec(src);
  console.log(fn ? '  calculateClientQuote exists in js/rental.js' : '  *** calculateClientQuote is MISSING ***');
  if (fn) {
    console.log('  signature: calculateClientQuote(' + fn[1].split('\n')[0] + ')');
    console.log('\n' + fn[0].split('\n').map(l => '    ' + l).join('\n'));
  }
})().catch(e => { console.error('probe failed:', e.message); process.exit(1); });

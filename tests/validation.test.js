// Regression tests for the fixes made during the full-system audit.
// These cover the pure helper modules (no database required).
const assert = require('node:assert/strict');
const { normalizeMediaUrl } = require('../backend/utils/media');
const { calculateRentalQuote, normalizeCategory, normalizeFuelType, normalizePlate } = require('../backend/utils/pricing');
const { BLOCKED_STATIC } = require('../backend/utils/security');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok - ${label}`);
}

console.log('media url normalization');

check('supports legacy "uploads/car.jpg"', () => {
  assert.equal(normalizeMediaUrl('uploads/car.jpg'), '/uploads/car.jpg');
});
check('supports legacy "/uploads/car.jpg"', () => {
  assert.equal(normalizeMediaUrl('/uploads/car.jpg'), '/uploads/car.jpg');
});
check('strips localhost origin to a relative path', () => {
  assert.equal(normalizeMediaUrl('http://localhost:5000/uploads/car.jpg'), '/uploads/car.jpg');
});
check('repairs a double-prefixed absolute url', () => {
  assert.equal(
    normalizeMediaUrl('http://localhost:5000/http://localhost:5000/uploads/car.jpg'),
    '/uploads/car.jpg'
  );
});
check('keeps remote CDN urls intact', () => {
  const remote = 'https://images.example.com/uploads/car.jpg';
  assert.equal(normalizeMediaUrl(remote), remote);
});
check('preserves data urls untouched', () => {
  const data = 'data:image/png;base64,AAAA';
  assert.equal(normalizeMediaUrl(data), data);
});
check('rejects path traversal', () => {
  assert.equal(normalizeMediaUrl('uploads/../../secret.txt'), '');
});
check('returns fallback for empty input', () => {
  assert.equal(normalizeMediaUrl('', '/img.png'), '/img.png');
});

console.log('pricing discount ordering');

const start = new Date('2030-01-01T10:00:00.000Z');
const end = new Date('2030-01-01T15:00:00.000Z');

check('discount is applied before tax', () => {
  const quote = calculateRentalQuote({
    vehicle: { price: 1000, priceUnit: 'day', discountPercent: 10, taxPercent: 10 },
    startDate: start, endDate: end, estimatedKm: 0
  });
  assert.equal(quote.subtotal, 1000);
  assert.equal(quote.discountAmount, 100);
  assert.equal(quote.discountedSubtotal, 900);
  assert.equal(quote.taxFees, 90, 'tax must be charged on the discounted amount');
  assert.equal(quote.grandTotal, 990);
});

check('zero discount preserves legacy totals', () => {
  const quote = calculateRentalQuote({
    vehicle: { price: 120, priceUnit: 'hour', includedKm: 300, extraKmRate: 10, taxPercent: 5 },
    startDate: start, endDate: end, estimatedKm: 450
  });
  assert.equal(quote.grandTotal, 2205);
  assert.equal(quote.discountAmount, 0);
});

check('discount is clamped to 100 percent', () => {
  const quote = calculateRentalQuote({
    vehicle: { price: 500, priceUnit: 'day', discountPercent: 500, taxPercent: 0 },
    startDate: start, endDate: end, estimatedKm: 0
  });
  assert.equal(quote.discountedSubtotal, 0);
  assert.equal(quote.grandTotal, 0);
});

check('rejects an inverted date range', () => {
  assert.throws(() => calculateRentalQuote({
    vehicle: { price: 100, priceUnit: 'day' }, startDate: end, endDate: start, estimatedKm: 0
  }), /Valid start and end/);
});

// Regression: a booking of "10:00 to 10:00, two days later" must bill 2 days.
// The client generates the two timestamps a few ms apart, which previously
// pushed the raw duration just past 48h and billed 3 days.
check('exact 48h rental bills 2 days despite millisecond drift', () => {
  const driftedStart = new Date(Date.now() + 3 * 86400000).toISOString();
  const driftedEnd = new Date(Date.now() + 5 * 86400000).toISOString();
  const quote = calculateRentalQuote({
    vehicle: { price: 1200, priceUnit: 'day' }, startDate: driftedStart, endDate: driftedEnd, estimatedKm: 0
  });
  assert.equal(quote.durationHours, 48);
  assert.equal(quote.billableUnits, 2);
  assert.equal(quote.grandTotal, 2400);
});

check('clean exact 48h rental bills 2 days', () => {
  const quote = calculateRentalQuote({
    vehicle: { price: 1200, priceUnit: 'day' },
    startDate: '2030-03-01T10:00:00.000Z', endDate: '2030-03-03T10:00:00.000Z', estimatedKm: 0
  });
  assert.equal(quote.durationHours, 48);
  assert.equal(quote.billableUnits, 2);
});

check('genuine partial extra day is still billed', () => {
  const quote = calculateRentalQuote({
    vehicle: { price: 1200, priceUnit: 'day' },
    startDate: '2030-03-01T10:00:00.000Z', endDate: '2030-03-03T16:00:00.000Z', estimatedKm: 0
  });
  assert.equal(quote.durationHours, 54);
  assert.equal(quote.billableUnits, 3, 'a real extra 6 hours must still cost a third day');
});

check('hourly billing is unaffected by the tolerance', () => {
  const quote = calculateRentalQuote({
    vehicle: { price: 120, priceUnit: 'hour' },
    startDate: '2030-03-01T10:00:00.000Z', endDate: '2030-03-01T15:00:00.000Z', estimatedKm: 0
  });
  assert.equal(quote.durationHours, 5);
  assert.equal(quote.grandTotal, 600);
});

console.log('normalization helpers');

check('category normalization', () => {
  assert.equal(normalizeCategory('cars'), 'Car');
  assert.equal(normalizeCategory('motorcycle'), 'Bike');
  assert.equal(normalizeCategory(''), 'Other');
});
check('fuel normalization', () => {
  assert.equal(normalizeFuelType('diesel'), 'Diesel');
  assert.equal(normalizeFuelType('nonsense'), 'Petrol');
});
check('plate normalization removes spaces and dashes', () => {
  assert.equal(normalizePlate('gj 01 ab 1234'), 'GJ01AB1234');
});

console.log('static exposure blocklist');

const blocked = ['/package.json', '/package-lock.json', '/vercel.json', '/backend/server.js', '/node_modules/express/index.js', '/.env', '/START_REVEX.bat', '/tests/pricing.test.js', '/deploy.log'];
const allowed = ['/', '/index.html', '/css/style.css', '/js/main.js', '/uploads/car.jpg', '/api/health'];

check('sensitive files are blocked', () => {
  for (const target of blocked) {
    assert.ok(BLOCKED_STATIC.some(pattern => pattern.test(target)), `expected ${target} to be blocked`);
  }
});
check('public assets remain reachable', () => {
  for (const target of allowed) {
    assert.ok(!BLOCKED_STATIC.some(pattern => pattern.test(target)), `expected ${target} to be allowed`);
  }
});

console.log(`\nvalidation tests passed (${checks} checks)`);

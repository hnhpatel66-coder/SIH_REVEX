/**
 * Drives the real js/rental.js against the REAL running server.
 *
 *   node scripts/verify-rental-live.js
 *
 * This is the end-to-end check for the price-breakdown bug: the page's own code
 * loads through the same DOM harness the offline suite uses, but api() talks to
 * http://localhost:5001 instead of a stub, so the numbers on screen are the
 * server's numbers.
 */
'use strict';

const { mountHarness } = require('../tests/harness/dom');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5001';
const VEHICLE_ID = process.argv[2];
const money = n => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

if (!VEHICLE_ID) {
  console.error('Usage: node scripts/verify-rental-live.js <vehicleId>');
  process.exit(1);
}

/**
 * A real HTTP fetch shaped like the harness's fetchImpl.
 *
 * `api()` is called with a path like `/vehicles/<id>/quote` and normally
 * prefixes it with the page's API base. The harness has no <base>, so the
 * prefix is applied here - without it every request 404s and the page silently
 * renders nothing, which looks exactly like the bug being hunted.
 */
const API_BASE = '/api';
async function liveFetch(pathname) {
  const withBase = pathname.startsWith('http') || pathname.startsWith(API_BASE)
    ? pathname
    : `${API_BASE}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
  const url = withBase.startsWith('http') ? withBase : BASE + withBase;
  const response = await fetch(url);
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (response.status >= 400) {
    console.log(`  ${response.status}  ${decodeURIComponent(withBase)}  -> ${(body && body.message) || '(no message)'}`);
  }
  return { status: response.status, body };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const h = mountHarness({
    elements: [{ id: 'vehicleDetail' }, { id: 'rentalBreakdown' }, { id: 'priceSuggestion' }],
    scripts: ['pricing.js', 'rental.js'],
    search: `?id=${encodeURIComponent(VEHICLE_ID)}`,
    fetchImpl: liveFetch
  });
  await h.document.fire('DOMContentLoaded');
  // Long enough for the first quote round trip. Reading sooner reports "no
  // total" for a page that is merely still loading, which looks like the bug.
  await sleep(1200);

  const box = () => h.byId.get('rentalBreakdown').innerText.replace(/\s+/g, ' ').trim();
  const shown = () => (box().match(/Grand Total (₹[\d,.]+)/) || [])[1] || '(none)';
  const label = () => (box().match(/Price breakdown ([^(]+)/) || [])[1] || '(none)';

  console.log(`page loaded against ${BASE}\n`);
  console.log('default window :', label(), '|', shown());

  // Ask the server directly what the final window costs.
  const day = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  const start = `${day(3)}T09:00`;
  const end = `${day(5)}T18:00`;
  const expected = (await liveFetch(`/api/vehicles/${VEHICLE_ID}/quote?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}&estimatedKm=180`)).body;

  // ONE FIELD AT A TIME, with a pause between, exactly as a person types.
  // This is the sequence that used to leave the default total frozen on screen.
  //
  // After every keystroke the total on screen is compared with what the SERVER
  // says for the window that is in the form AT THAT MOMENT - not with the final
  // window. Typing the end date before the end time genuinely leaves a different
  // (valid) window in the form, and the page is right to price that one.
  const steps = [['startDate', day(3)], ['startTime', '09:00'], ['endDate', day(5)], ['endTime', '18:00'], ['estimatedKm', '180']];
  let stale = 0;
  for (const [id, value] of steps) {
    h.byId.get(id).value = value;
    await h.byId.get(id).dispatch('input');
    await sleep(500);

    const now = {
      start: `${h.byId.get('startDate').value}T${h.byId.get('startTime').value}`,
      end: `${h.byId.get('endDate').value}T${h.byId.get('endTime').value}`,
      km: h.byId.get('estimatedKm').value || 0
    };
    const wanted = (await liveFetch(`/api/vehicles/${VEHICLE_ID}/quote?startDate=${encodeURIComponent(now.start)}&endDate=${encodeURIComponent(now.end)}&estimatedKm=${now.km}`)).body;
    const total = shown();
    const agrees = total === money(wanted.grandTotal);
    if (total !== '(none)' && !agrees) stale += 1;
    const why = agrees ? 'matches the server for the window in the form'
      : total === '(none)' ? '(the window in the form is not yet valid, so nothing is shown)'
        : '*** SHOWING A TOTAL FOR A DIFFERENT WINDOW ***';
    console.log(`after ${id.padEnd(12)}: ${String(total).padEnd(12)} ${why}`);
  }

  console.log('');
  console.log('form window   :', start, '->', end);
  console.log('server says   :', expected.durationLabel, '|', money(expected.grandTotal));
  console.log('page shows    :', label(), '|', shown());
  console.log('');
  console.log(stale === 0 ? 'PASS  the page never showed a total for a window other than the one in the form'
                           : `FAIL  a stale total was visible ${stale} time(s)`);

  // And the booking button must agree with what is on screen.
  h.consent.checked = true;
  await h.consent.dispatch('change');
  const enabled = !h.button.disabled;
  const consistent = enabled === (shown() !== '(none)' && shown() === money(expected.grandTotal));
  console.log(consistent ? 'PASS  the booking button is enabled exactly when the priced window is the one in the form'
                         : 'FAIL  the booking button does not match the displayed price');

  process.exit(stale === 0 && consistent ? 0 : 1);
})().catch(error => { console.error('verify failed:', error.message); process.exit(1); });

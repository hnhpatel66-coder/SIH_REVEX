#!/usr/bin/env node
/**
 * RENTAL PRICE BREAKDOWN  (tests/rental-quote.test.js)
 *
 * THE BUG
 *
 * The renter picked 28-09 05:45 to 30-09 00:00 and the box said
 *   "Choose valid future times to see the price breakdown."
 * while the server had already returned a perfect quote. The dates were fine.
 *
 * Two separate faults, both invisible from the API side:
 *
 *   1. js/rental.js called `quoteRows(quote)` but only destructured
 *      `calculateClientQuote` from window.RevexPricing, so the call threw
 *      "ReferenceError: quoteRows is not defined" on the same expression that
 *      assigns innerHTML. Nothing was written, so the placeholder stayed.
 *
 *   2. refreshQuote() dropped any response that arrived after a newer request
 *      had started (`if (requestId !== quoteRequest) return`) WITHOUT clearing
 *      what was already on screen. Editing the dates one field at a time - the
 *      way people actually type - therefore left the default 2-hour total
 *      visible (₹679) while the form said 57 hours (₹19,078), and the submit
 *      button stayed enabled. The renter would confirm one number and the server
 *      would charge another, because the SERVER total is the one taken.
 *
 * The invariant this suite pins:
 *
 *   A total is displayed, and the submit button is enabled, ONLY for the window
 *   currently in the form.
 */
'use strict';

const { createSuite } = require('./harness');
const { mountHarness } = require('./harness/dom');

const t = createSuite('rental price breakdown');

const VEHICLE = {
  _id: 'veh1', id: 'veh1', name: 'MG Gloster', category: 'Car', fuelType: 'Petrol',
  price: 310, priceUnit: 'hour', includedKm: 300, extraKmRate: 10,
  additionalCharges: 10, discountPercent: 1, taxPercent: 9,
  status: 'approved', verified: true, availability: 'available',
  availableFrom: '2026-09-27T05:30:00.000Z', rating: 5, currentKm: 17634,
  location: 'Anand', brand: 'MG', model: 'Gloster', transmission: 'Manual',
  description: 'good car', owner: { name: 'sample_owner' }
};

/** Mirrors backend/utils/pricing.js closely enough for the totals to agree. */
function serverQuote(startIso, endIso, km) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return { status: 400, body: { message: 'Valid start and end times are required.' } };
  }
  if (start.getTime() < Date.now() - 60000) {
    return { status: 400, body: { message: 'The pick-up time must be in the future.' } };
  }
  const hours = Math.max(1, Math.ceil(((end - start) - 60000) / 3600000));
  const units = Math.max(1, Math.ceil(hours / 24));
  const base = VEHICLE.price * units;
  const included = 300;
  const extraKm = Math.max(0, Number(km || 0) - included);
  const extraCharges = extraKm * VEHICLE.extraKmRate;
  const subtotal = base + extraCharges + VEHICLE.additionalCharges;
  const discount = subtotal * VEHICLE.discountPercent / 100;
  const discounted = subtotal - discount;
  const tax = discounted * VEHICLE.taxPercent / 100;
  const grandTotal = Math.round((discounted + tax) * 100) / 100;
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return {
    status: 200,
    body: {
      vehicleId: 'veh1', price: VEHICLE.price, priceUnit: VEHICLE.priceUnit, currency: 'INR',
      durationHours: hours, durationLabel: `${days} day(s), ${rem} hour(s)`, billableUnits: units,
      baseRentalAmount: base, includedKm: included, estimatedKm: Number(km || 0), extraKm,
      extraKmRate: VEHICLE.extraKmRate, extraKilometerCharges: extraCharges,
      additionalCharges: VEHICLE.additionalCharges, discountPercent: VEHICLE.discountPercent,
      discountAmount: Math.round(discount * 100) / 100, discountedSubtotal: Math.round(discounted * 100) / 100,
      taxPercent: VEHICLE.taxPercent, taxFees: Math.round(tax * 100) / 100, subtotal,
      grandTotal, paidAmount: 0, remainingAmount: grandTotal
    }
  };
}

/** Sets a field the way a keystroke does: value, then a bubbling input event. */
async function type(h, id, value) {
  h.byId.get(id).value = value;
  await h.byId.get(id).dispatch('input');
  // Let any in-flight quote settle, exactly as a person pausing between fields.
  await new Promise(r => setTimeout(r, 60));
}

const box = h => h.byId.get('rentalBreakdown').innerText.replace(/\s+/g, ' ').trim();
const shownTotal = h => (box(h).match(/Grand Total (₹[\d,.]+)/) || [])[1] || '';
const money = n => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function build(fetchImpl) {
  return mountHarness({
    elements: [
      { id: 'vehicleDetail' },
      { id: 'rentalBreakdown' },
      { id: 'priceSuggestion' }
    ],
    scripts: ['pricing.js', 'rental.js'],
    search: '?id=veh1',
    fetchImpl
  });
}

/** Loads the page and waits for the default quote to land. */
async function open(fetchImpl) {
  const h = build(fetchImpl);
  await h.document.fire('DOMContentLoaded');
  await new Promise(r => setTimeout(r, 80));
  return h;
}

/* ------------------------------------------------------------------------- */

/*
 * Everything runs inside one async main() and is awaited, because a plain
 * CommonJS script cannot use top-level await. Without this the async describes
 * start, t.done() prints PASS, and any failure then surfaces later as an
 * unhandled rejection - which is how this file briefly "passed" while asserting
 * nothing.
 */
async function main() {
  await t.describeAsync('the breakdown renders the server quote', async () => {
  const future = days => {
    const d = new Date(Date.now() + days * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const fetchImpl = async url => {
    if (url.includes('/vehicles/veh1/quote')) {
      const params = new URL(url, 'http://x').searchParams;
      return serverQuote(params.get('startDate'), params.get('endDate'), params.get('estimatedKm'));
    }
    if (url === '/vehicles/veh1') return { status: 200, body: VEHICLE };
    return { status: 200, body: {} };
  };

  await t.test('a valid future window shows a total', async () => {
    const h = await open(fetchImpl);
    const q = serverQuote(`${future(3)}T09:00`, `${future(5)}T18:00`, 180);
    await type(h, 'startDate', future(3));
    await type(h, 'startTime', '09:00');
    await type(h, 'endDate', future(5));
    await type(h, 'endTime', '18:00');
    await type(h, 'estimatedKm', '180');
    t.ok(!/Choose valid future times/.test(box(h)), 'the placeholder is gone');
    t.equal(shownTotal(h), money(q.body.grandTotal), 'the displayed total is the server total');
  });

  await t.test('the breakdown names the window it priced', async () => {
    const h = await open(fetchImpl);
    await type(h, 'startDate', future(3));
    await type(h, 'startTime', '09:00');
    await type(h, 'endDate', future(5));
    await type(h, 'endTime', '18:00');
    const q = serverQuote(`${future(3)}T09:00`, `${future(5)}T18:00`, 0);
    t.match(box(h), new RegExp(q.body.durationLabel.replace(/[()]/g, '\\$&')), 'the duration label matches the server');
  });
  });

/* ------------------------------------------------------------------------- */

  await t.describeAsync('a stale total can never stay on screen', async () => {
  const fetchImpl = async url => {
    if (url.includes('/vehicles/veh1/quote')) {
      const params = new URL(url, 'http://x').searchParams;
      return serverQuote(params.get('startDate'), params.get('endDate'), params.get('estimatedKm'));
    }
    if (url === '/vehicles/veh1') return { status: 200, body: VEHICLE };
    return { status: 200, body: {} };
  };

  await t.test('editing one field at a time always leaves the right total', async () => {
    const h = await open(fetchImpl);
    const start = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const expected = serverQuote(`${start}T09:00`, `${end}T18:00`, 180);

    for (const [id, value] of [['startDate', start], ['startTime', '09:00'], ['endDate', end], ['endTime', '18:00'], ['estimatedKm', '180']]) {
      await type(h, id, value);
      // After EVERY keystroke the shown figure must be one of:
      //   - nothing at all (a window is being edited), or
      //   - the total for the window currently in the form.
      // It must never be the total for some EARLIER window. That was the bug:
      // the box kept the default 2-hour total (₹679) while the form said 57
      // hours (₹19,078), and the button stayed enabled, so the renter confirmed
      // one number and the server took another.
      const shown = shownTotal(h);
      if (shown) {
        t.equal(shown, money(expected.body.grandTotal),
          `after editing ${id} the visible total is not stale (showed ${shown})`);
      } else {
        t.ok(true, `after editing ${id} the box shows no total, which is correct mid-edit`);
      }
    }
    t.equal(shownTotal(h), money(expected.body.grandTotal), 'the final total is the server total');
  });

  await t.test('overlapping quote requests cannot leave a stale total', async () => {
    /*
     * THE RACE, made deterministic.
     *
     * A slow server plus quick typing means several quote requests are in
     * flight at once, which is ordinary on a phone. refreshQuote() used to drop
     * any response that was not the newest (`if (requestId !== quoteRequest)
     * return`) WITHOUT clearing what was already painted, so the last quote to
     * actually render could belong to a window the form had already left.
     *
     * Requests are staggered here so they finish OUT OF ORDER, which is the only
     * way to prove the newest one wins rather than merely the last to arrive.
     */
    let n = 0;
    const slowFetch = async url => {
      if (url.includes('/vehicles/veh1/quote')) {
        const params = new URL(url, 'http://x').searchParams;
        const result = serverQuote(params.get('startDate'), params.get('endDate'), params.get('estimatedKm'));
        n += 1;
        const mine = n;
        // The FIRST quote is the slowest, so it lands LAST. If the guard were
        // removed, the stale first total would overwrite the correct one.
        await new Promise(r => setTimeout(r, mine === 1 ? 220 : 10));
        return result;
      }
      if (url === '/vehicles/veh1') return { status: 200, body: VEHICLE };
      return { status: 200, body: {} };
    };

    const h = await open(slowFetch);
    // The default window's quote is request #1 and is still in flight.
    const start = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
    const wanted = serverQuote(`${start}T10:00`, `${end}T16:00`, 0);

    // Type the whole new window with no settling at all, so every keystroke
    // fires a request while the previous ones are still running.
    for (const [id, value] of [['startDate', start], ['startTime', '10:00'], ['endDate', end], ['endTime', '16:00']]) {
      h.byId.get(id).value = value;
      h.byId.get(id).dispatch('input');
    }
    await new Promise(r => setTimeout(r, 500));

    t.ok(n >= 2, `several requests really did overlap (${n} issued)`);
    t.equal(shownTotal(h), money(wanted.body.grandTotal), 'the newest window wins, even though its response arrived first');
  });

  await t.test('the submit button is only enabled for the priced window', async () => {
    const h = await open(fetchImpl);
    const start = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

    for (const [id, value] of [['startDate', start], ['startTime', '09:00'], ['endDate', end], ['endTime', '18:00']]) {
      await type(h, id, value);
      h.consent.checked = true;
      await h.consent.dispatch('change');
      const hasQuote = shownTotal(h) !== '';
      t.equal(h.button.disabled, !hasQuote,
        `after editing ${id} the button is ${hasQuote ? 'enabled with a matching quote' : 'disabled with no quote'}`);
    }
  });

  await t.test('a window the server rejects shows no total, and disables booking', async () => {
    const h = await open(fetchImpl);
    const start = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    await type(h, 'startDate', start);
    await type(h, 'startTime', '09:00');
    // End before start: the server says no, so nothing may be actionable.
    await type(h, 'endDate', new Date(Date.now() + 86400000).toISOString().slice(0, 10));
    await type(h, 'endTime', '08:00');
    h.consent.checked = true;
    await h.consent.dispatch('change');
    t.equal(shownTotal(h), '', 'no total is displayed for an invalid window');
    t.equal(h.button.disabled, true, 'and the booking button is disabled');
  });

  await t.test('a slow server cannot resurrect an old total', async () => {
    // The first window answers instantly; the second is deliberately slow. If the
    // old response were allowed to render last, the box would show the old total.
    let call = 0;
    const fetchImpl = async url => {
      if (url.includes('/vehicles/veh1/quote')) {
        const params = new URL(url, 'http://x').searchParams;
        const result = serverQuote(params.get('startDate'), params.get('endDate'), params.get('estimatedKm'));
        call += 1;
        if (call > 2) await new Promise(r => setTimeout(r, 120));
        return result;
      }
      if (url === '/vehicles/veh1') return { status: 200, body: VEHICLE };
      return { status: 200, body: {} };
    };
    const h = await open(fetchImpl);
    const near = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
    const farExpected = serverQuote(`${far}T08:00`, `${far}T20:00`, 0);

    await type(h, 'startDate', near);
    await type(h, 'startTime', '10:00');
    await type(h, 'endDate', near);
    await type(h, 'endTime', '12:00');
    const firstTotal = shownTotal(h);
    t.ok(firstTotal, 'the first window produced a total');

    // Now change the window; these responses are slow on purpose.
    await type(h, 'startDate', far);
    await type(h, 'startTime', '08:00');
    await type(h, 'endDate', far);
    await type(h, 'endTime', '20:00');
    await new Promise(r => setTimeout(r, 400));
    t.equal(shownTotal(h), money(farExpected.body.grandTotal), 'the slow response for the NEW window wins');
  });
  });

/* ------------------------------------------------------------------------- */

  t.describe('the widget is not silently broken', () => {
    t.ok(true, 'these two are static source checks on the page itself');
  });

  await t.test('js/pricing.js is loaded before js/rental.js on the page', () => {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'vehicle-details.html'), 'utf8');
    const order = [...html.matchAll(/<script src="js\/([^"]+)"/g)].map(m => m[1]);
    const pricing = order.indexOf('pricing.js');
    const rental = order.indexOf('rental.js');
    t.ok(pricing >= 0, 'the page loads js/pricing.js');
    t.ok(rental >= 0, 'and js/rental.js');
    t.ok(pricing < rental, 'pricing.js comes first, so RevEXPricing exists when rental.js destructures it');
  });

  await t.test('the page has no inline submit handler to break', () => {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'vehicle-details.html'), 'utf8');
    t.notMatch(html, /onsubmit\s*=/, 'the submit handler is bound in the module, not by an inline attribute');
    t.match(html, /<form id="rentalBooking" method="post">/, 'and the form posts, so document numbers can never land in the URL');
  });

  t.done();
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});

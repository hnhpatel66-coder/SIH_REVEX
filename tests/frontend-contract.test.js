#!/usr/bin/env node
/**
 * FRONTEND CONTRACT  (tests/frontend-contract.test.js)
 *
 * Static checks that pin the promises the 1.3 frontend makes to the user, so a
 * regression cannot quietly reintroduce a bug that was already found and fixed.
 *
 * Each check names the bug it prevents. They are cheap (no browser, no server)
 * and run in milliseconds, which is the point: they should catch a mistake
 * before anyone starts the app.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./harness');

const ROOT = path.join(__dirname, '..');
const t = createSuite('frontend contract');

const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
/** Strips block and line comments so a check can assert on real code only. */
const code = file => read(file)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const pages = fs.readdirSync(ROOT).filter(name => name.endsWith('.html'));
const scripts = fs.readdirSync(path.join(ROOT, 'js')).filter(name => name.endsWith('.js'));

/* ------------------------------------------------------------------ shared */

t.describe('API base resolution is preserved', () => {
  const main = read('js/main.js');
  // The exact shapes other suites and the deployed pages depend on.
  t.match(main, /const REVEX_DEFAULT_API_PORT = 5001;/, 'the default API port stays 5001');
  t.match(main, /const LOCAL_HOSTS = \[[\s\S]*?'::1'[\s\S]*?\];/, 'LOCAL_HOSTS is still a single array literal ending in ];');
  t.match(main, /function resolveApiBase\(\)/, 'resolveApiBase() is still the single entry point');
  t.match(main, /window\.REVEX = \{/, 'the shared namespace is exported for the other modules');
  t.match(main, /<meta name="revex-api-base"|meta\[name="revex-api-base"\]|'meta\[name="revex-api-base"\]'/, 'the per-page meta override is still honoured');
  t.match(main, /\/rev-runtime\.js|REVEX_API_BASE/, 'the server-provided runtime config is still supported');
});

/* ------------------------------------------------------------- payment flow */

t.describe('"Pay & Book Ride" replaces the old wording', () => {
  t.match(code('js/rides.js'), /Pay &amp; Book Ride|Pay & Book Ride/, 'the ride flow uses the agreed button label');
  t.notMatch(code('js/rides.js'), /Review and pay/i, 'the old "Review and pay" wording is gone from the code');
  t.notMatch(code('ride-details.html'), /Review and pay/i, 'the old wording is gone from the page too');
  t.match(read('ride-details.html'), /Pay &amp; Book Ride/, 'the booking button says Pay & Book Ride');
});

t.describe('the amount is never computed in the browser', () => {
  const rides = read('js/rides.js');
  t.match(rides, /\/quote\?seats=/, 'the seat total comes from the backend quote endpoint');
  t.match(rides, /function quoteLines/, 'the breakdown is rendered from the server quote');
  // The old code recomputed `seats * price` from a hidden input.
  t.notMatch(rides, /seats \* (Number|price)/, 'there is no client-side seats x price total left');
  t.match(read('js/payment.js'), /The order is created server-side, so the amount can never be forged here\./, 'the payment client documents that the amount is the server\'s');
  t.match(code('js/payment.js'), /settling = new Map\(\)/, 'there is a single-settlement latch against double clicks');
});

t.describe('there is no fake payment success', () => {
  const rides = code('js/rides.js');
  const rental = code('js/rental.js');
  t.match(rides, /verify-payment/, 'the ride flow verifies the payment on the server');
  t.match(rental, /verify-payment/, 'the rental flow verifies the payment on the server');
  t.match(rides, /payment-test/, 'the test-payment path is used only when no gateway exists');
  // No route may report success without the server having confirmed it.
  t.notMatch(rides, /Your seat is confirmed\./, 'the client no longer claims a seat is confirmed on its own');
  const backend = code('backend/routes/rides.js');
  t.match(backend, /gateway\.verifyCheckout/, 'server-side signature verification is used');
  t.match(backend, /expectedAmountPaise/, 'the collected amount is checked against the amount due');
});

/* ------------------------------------------------------- vehicle image reuse */

t.describe('the vehicle photo is reused, not re-uploaded', () => {
  const rides = read('js/rides.js');
  const backend = read('backend/routes/rides.js');
  t.match(rides, /populateVehiclePicker/, 'the offer form offers a registered-vehicle picker');
  t.match(rides, /\/vehicles\/mine/, 'the picker reads the owner\'s registered vehicles');
  t.match(rides, /Using the photo and details of/, 'the UI states that the registered photo is used');
  t.match(backend, /function vehicleImageFor\(vehicle, provided\)/, 'the backend prefers the registered vehicle photo');
  t.match(backend, /vehicleId: linkedVehicle \? linkedVehicle\._id : null/, 'the offer points at the registered vehicle record');
  // The manual upload must still exist for an owner with no approved vehicle.
  t.match(rides, /Enter the vehicle details manually/, 'a manual fallback is offered');
  t.match(read('offer-ride.html'), /name="vehicleId"/, 'the offer form has the vehicle picker');
});

/* ------------------------------------------------------------------- images */

t.describe('every image falls back to initials', () => {
  const main = read('js/main.js');
  t.match(main, /function imageOrInitials/, 'the shared image helper exists');
  t.match(main, /onerror=/, 'the helper handles a broken image URL');
  for (const file of ['js/rides.js', 'js/admin.js', 'js/booking.js', 'js/ride-requests.js', 'js/owner.js']) {
    const source = read(file);
    t.notMatch(source, /REVEX Ride<\/text>|REVEX Vehicle<\/text>/, `${file} no longer builds an inline SVG placeholder`);
  }
});

t.describe('profile photos exist end to end', () => {
  t.match(read('backend/models/User.js'), /photo: \{ type: String, default: '' \}/, 'the User model stores a profile photo');
  t.match(read('backend/routes/auth.js'), /removePhoto/, 'the profile update accepts and can clear a photo');
  t.match(read('backend/routes/auth.js'), /Profile photo must be a PNG/, 'the upload is validated with a specific message');
  t.match(read('backend/routes/admin.js'), /photo: normalizeMediaUrl\(user\.photo, ''\)/, 'the admin user list resolves the photo');
  t.match(read('js/profile-page.js'), /profile photo/i, 'the profile page exposes a photo upload');
  t.match(read('profile.html'), /id="editPhoto"/, 'the profile page has the photo input');
  t.match(read('js/main.js'), /imageOrInitials\(user\.photo/, 'the navbar uses the same photo');
});

/* ------------------------------------------------------------- cancellation */

t.describe('cancellation shows the server\'s numbers', () => {
  const booking = read('js/booking.js');
  t.match(booking, /cancellation-preview/, 'the UI asks the server what the fee and refund will be');
  t.match(booking, /free-cancellation window/i, 'the free window is explained in the confirm dialog');
  t.match(read('backend/routes/bookings.js'), /router\.get\('\/:id\/cancellation-preview'/, 'the rental preview endpoint exists');
  t.match(read('backend/routes/rides.js'), /router\.get\('\/bookings\/:id\/cancellation-preview'/, 'the ride preview endpoint exists');
  t.match(read('backend/routes/admin.js'), /router\.patch\('\/bookings\/:id\/status'/, 'the admin can cancel a rental booking');
  t.match(read('backend/routes/admin.js'), /router\.patch\('\/ride-bookings\/:id\/status'/, 'the admin can cancel a ride booking');
  // No hard-coded percentages anywhere in the source.
  const sources = [
    ...scripts.map(name => read(path.join('js', name))),
    ...fs.readdirSync(path.join(ROOT, 'backend', 'routes')).map(name => read(path.join('backend/routes', name)))
  ].join('\n');
  t.notMatch(sources, /0\.1[0-9]?\s*\*\s*amount|cancelFee\s*=\s*\d/, 'no hard-coded cancellation percentage in the frontend or routes');
  t.match(code('backend/utils/cancellation.js'), /env\.CANCEL_FEE_PERCENT_USER/, 'the fee is read from the environment');
});

/* ------------------------------------------------------------- error wording */

t.describe('errors are specific, not generic', () => {
  const main = read('js/main.js');
  t.match(main, /function showToast/, 'a non-blocking toast helper exists');
  t.match(main, /function confirmAction/, 'a promise-based confirm replaces prompt()');
  for (const file of scripts) {
    const source = read(path.join('js', file));
    const lines = source.split('\n').filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/*'));
    const offenders = lines.filter(line => /(?<![.\w])alert\(/.test(line) || /(?<![.\w])prompt\(/.test(line));
    t.equal(offenders.length, 0, `${file} uses no blocking alert()/prompt() (${offenders.length} found)`);
  }
});

/* --------------------------------------------------------------- ride flow */

t.describe('the ride flow keeps the two approvals apart', () => {
  const backend = read('backend/routes/rides.js');
  t.match(backend, /router\.patch\('\/:id\/verify'|router\.post\('\/bookings\/:id\/decision'/, 'the offer approval and the owner decision are different endpoints');
  t.match(backend, /claimSeats/, 'seats are claimed atomically');
  t.match(backend, /\$expr/, 'the seat claim uses a guarded $expr update');
  t.match(backend, /bookedSeatsByRide/, 'seat availability is read from the booking ledger');
  const requests = read('js/ride-requests.js');
  t.match(requests, /only lists PAID requests|only ever lists PAID requests/i, 'unpaid holds are documented as excluded from the owner request list');
  const ownerRequests = read('backend/routes/rides.js');
  t.notMatch(ownerRequests.slice(ownerRequests.indexOf("router.get('/requests'"), ownerRequests.indexOf("router.get('/requests'") + 900), /payment_pending/, 'unpaid holds are not returned to the owner');
});

/* ------------------------------------------------------------- owner summary */

t.describe('the Owner Summary dashboard is one request', () => {
  const admin = read('backend/routes/admin.js');
  t.match(admin, /router\.get\('\/owners\/:id'/, 'the owner detail endpoint exists');
  t.match(admin, /const revenue = \{[\s\S]*?ownerShareRate/, 'the owner summary returns a revenue split');
  t.match(admin, /const activity = \{[\s\S]*?userBookingCount/, 'the owner summary returns the activity counters');
  t.match(admin, /const verification = \{[\s\S]*?documents:/, 'the owner summary returns documents');
  t.match(admin, /cancellationInfo: \{/, 'each ride reports its cancellation information');
  const js = read('js/admin.js');
  t.match(js, /data-owner-details/, 'the owners list can open the dashboard');
  t.match(js, /data-vehicle-status/, 'vehicles inside the owner summary can be removed without deleting them');
  t.match(js, /data-verify/, 'vehicles inside the owner summary can be approved or rejected');
  t.match(js, /api\(`\/admin\/owners\/\$\{encodeURIComponent\(id\)\}`\)/, 'the dashboard is fetched from that single endpoint');
});

/* --------------------------------------------------------------------- chat */

t.describe('the assistant is authenticated and per-user', () => {
  const chat = read('backend/routes/chat.js');
  // Provider resolution (endpoint, key, dialect) lives in utils/chatProvider.js
  // so it can be unit-tested offline; the route is only the HTTP surface.
  const provider = read('backend/utils/chatProvider.js');
  t.match(chat, /requireAuth/, 'every chat endpoint requires a session');
  t.match(chat, /userId: req\.user\._id/, 'conversations are scoped to the signed-in user');
  t.match(chat, /utils\/chatProvider/, 'the route delegates provider work to the shared module');
  t.match(provider, /CHAT_API_URL/, 'the provider endpoint is configurable');
  t.match(provider, /CHAT_API_KEY/, 'the key comes from the environment');
  // A Google AI Studio key must be enough on its own; demanding a second
  // variable left the assistant reporting "not configured" with a valid key.
  // The derivation must NOT inspect the key: Google has shipped more than one
  // key format, and a prefix check rejected a key that demonstrably worked.
  t.match(provider, /isGoogleAiKey/, 'a Google key shape is recognised, for messaging only');
  t.match(provider, /GEMINI_BASE/, 'and the official endpoint is derived from it');
  t.match(provider, /\}\s*else if \(apiKey\)\s*\{/, 'any key with no URL set gets the derived endpoint');
  t.notMatch(provider, /else if \(apiKey && isGoogleAiKey\(apiKey\)\)/, 'derivation is never gated on the key prefix');
  t.notMatch(provider, /GEMINI_API_KEY\s*=\s*['"][^'"]+['"]/, 'no key is hard-coded');
  t.match(read('js/chat.js'), /textContent = String\(text/, 'assistant output is inserted as text, never as HTML');
  t.match(read('js/main.js'), /window\.RevexChat\?\.mount\(\{ launcher: true \}\)/, 'main.js mounts the assistant with a launcher');
  t.match(read('js/chat.js'), /function mount\(options = \{\}\)/, 'the chat module exposes a single mount() entry point');
  t.match(read('admin.html'), /data-tab="chat"/, 'the admin panel has a Chat tab');
  t.match(read('chat.html'), /chat-page\.js/, 'the full-page assistant exists');
});

/* ------------------------------------------------------------------ payments */

t.describe('the payment method is decided by the server', () => {
  t.match(read('js/payment.js'), /\/payments\/config/, 'the client asks the server which method is available');
  // "Configured" only means the env variables are non-empty. A revoked or
  // mistyped key pair passes that test and then fails every real order, so the
  // decision is made on a live probe instead.
  t.match(read('backend/routes/payments.js'), /testModeAvailable: !health\.usable/, 'the test payment is offered whenever real payments cannot succeed');
  const rides = read('backend/routes/rides.js');
  t.match(rides, /const health = await gateway\.checkHealth\(\)/, 'the ride demo endpoint runs the same probe');
  t.match(rides, /if \(health\.usable\) return res\.status\(409\)/, 'the server refuses a test payment while online payment works');
  t.match(read('backend/routes/bookings.js'), /if \(health\.usable\) return res\.status\(409\)/, 'and so does the rental flow');
  t.match(rides, /paymentMethod: 'demo'/, 'a test payment is stored as demo, never as real money');
  t.match(read('backend/utils/payments.js'), /timingSafeEqual/, 'signature comparison is constant-time');
  t.match(read('backend/utils/payments.js'), /never leaves the server/, 'the secret key is documented as server-only');
});

t.describe('revenue split labels match the numbers', () => {
  const js = code('js/admin.js');
  // ownerShareRate is the OWNER's rate (0.9). Printing it next to the platform
  // share captioned a 10% commission as "90% service fee" on the dashboard, in
  // the reports and in the owner summary.
  t.match(js, /function ownerSharePercent\(rate\)/, 'one helper owns the owner-rate conversion');
  t.match(js, /statCard\('Platform share'[\s\S]{0,120}?100 - ownerRate\}% service fee/, 'the dashboard platform share uses the complement of the owner rate');
  t.match(js, /statCard\('Platform share'[\s\S]{0,200}?100 - incomeOwnerRate\}% service share/, 'the reports platform share uses the complement of the owner rate');
  t.match(js, /100 - ownerSharePercent\(revenue\.ownerShareRate\)/, 'the owner summary platform share uses the complement of the owner rate');
  t.notMatch(js, /statCard\('Platform share'[^)]*ownerShareRate \?\? 0\.1/, 'the platform share is never labelled with the raw owner rate');
  t.match(js, /statCard\('Owner payout'[\s\S]{0,90}?\$\{ownerRate\}% of gross/, 'the owner payout is labelled with the owner rate');
});

/* ------------------------------------------------------------------ wiring */

/*
 * THE BUG: every inline handler in the markup pointed at a function that lives
 * inside a module IIFE and is never put on `window`.
 *
 *   vehicle-details.html  onsubmit="confirmRental(event)"
 *   list-vehicle.html     oninput="updatePriceSuggestion()"
 *   list-vehicle.html     onblur="checkPlate(this.value)"
 *
 * An inline attribute resolves its callee against `window`, so each one threw
 * "ReferenceError: ... is not defined" and silently did nothing. The rental one
 * was the serious one: because it was the form's submit handler and it never
 * ran, preventDefault() never happened either, so the browser did a default GET
 * submit and put the renter's PAN number and driving licence number in the URL,
 * the address bar, the history and any Referer header.
 *
 * This is a static check, so it catches the mistake before anyone starts the app.
 */
t.describe('inline handlers all resolve to a real global', () => {
  const jsSources = fs.readdirSync(path.join(ROOT, 'js'))
    .filter(name => name.endsWith('.js'))
    .map(name => ({ name, source: read(path.join('js', name)) }));
  const htmlFiles = fs.readdirSync(ROOT).filter(name => name.endsWith('.html'));

  const globalFunctions = new Set();
  jsSources.forEach(({ source }) => {
    for (const match of source.matchAll(/(?:global|window)\.([A-Za-z_$][\w$]*)\s*=/g)) globalFunctions.add(match[1]);
  });

  const offenders = [];
  htmlFiles.forEach(file => {
    const source = read(file);
    for (const match of source.matchAll(/\son[a-z]+\s*=\s*"([A-Za-z_$][\w$]*)\s*\(/g)) {
      const fn = match[1];
      if (!globalFunctions.has(fn)) offenders.push(`${file} -> ${fn}`);
    }
  });
  t.equal(offenders.length, 0,
    `every inline on*= handler must name a function that reaches window. Offenders: ${offenders.join(', ') || 'none'}`);
  t.equal(htmlFiles.some(file => /\son(?:submit|input|change|blur|click)\s*=\s*"/.test(read(file))),
    false, 'and there are no inline handlers at all, because all of them were broken');

  // The rental form must not be able to leak document numbers into the URL even
  // if its JavaScript fails to load.
  const details = read('vehicle-details.html');
  t.match(details, /<form id="rentalBooking" method="post">/,
    'the rental form posts, so a JS failure cannot put the PAN and licence numbers in the query string');
  t.match(details, /name="panNumber"/, 'it does collect a PAN number, which is exactly why the method matters');
  t.match(details, /name="drivingLicenseNumber"/, 'and a driving licence number');
  t.match(read('js/rental.js'), /addEventListener\('submit', event => \{ event\.preventDefault\(\); confirmRental\(event\); \}\)/,
    'the submit handler is bound in the module, where confirmRental actually resolves');
});

/*
 * THE BUG: js/rental.js called `quoteRows(quote)` but only destructured
 * `calculateClientQuote` from window.RevexPricing. `quoteRows` was therefore an
 * unresolved identifier and threw "ReferenceError: quoteRows is not defined"
 * inside renderQuote() - on the same line that assigns the breakdown's
 * innerHTML, so the throw happened before anything was written and the box kept
 * its original "Choose valid future times" message.
 *
 * The server had returned a perfectly good quote the whole time, so the renter
 * was told their dates were invalid and the submit button stayed disabled
 * forever. Nothing about the dates was wrong.
 *
 * The general rule this pins: a module must import every helper it calls.
 */
t.describe('a module never calls a helper it did not import', () => {
  const htmlFiles = fs.readdirSync(ROOT).filter(name => name.endsWith('.html'));
  const scriptOrder = new Map();
  htmlFiles.forEach(file => {
    const order = [];
    for (const match of read(file).matchAll(/<script src="js\/([^"]+)"/g)) order.push(match[1]);
    scriptOrder.set(file, order);
  });

  const sharedNamespaces = { 'js/pricing.js': 'RevexPricing', 'js/chat.js': 'RevexChat', 'js/payment.js': 'RevexPay' };
  const missing = [];

  Object.entries(sharedNamespaces).forEach(([provider, namespace]) => {
    const providerSource = read(provider);
    const exported = new Set();
    for (const match of providerSource.matchAll(new RegExp(`${namespace}\\s*=\\s*\\{([^}]*)\\}`, 'g'))) {
      match[1].split(',').forEach(part => {
        const name = part.split(':')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) exported.add(name);
      });
    }
    if (!exported.size) return;

    fs.readdirSync(path.join(ROOT, 'js')).filter(name => name.endsWith('.js')).forEach(name => {
      if (name === path.basename(provider)) return;
      const raw = read(path.join('js', name));
      // Comments are stripped first. Prose such as "Razorpay checkout (or a
      // labelled test payment)" names a helper without calling it, and matching
      // that would report a bug that does not exist.
      const source = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
        .replace(/(^|[^:'"])\/\/[^\n'"]*$/gm, '$1');
      // Only audit a consumer on pages that actually load the provider first.
      const loadsProvider = [...scriptOrder.values()].some(order => {
        const at = order.indexOf(name);
        const providerAt = order.indexOf(path.basename(provider));
        return at >= 0 && providerAt >= 0 && providerAt < at;
      });
      if (!loadsProvider) return;

      exported.forEach(helper => {
        const called = new RegExp(`(?<![.\\w$])${helper}\\s*\\(`).test(source);
        if (!called) return;
        const imported = new RegExp(`\\{[^}]*\\b${helper}\\b[^}]*\\}\\s*=\\s*(global|window)\\.${namespace}`).test(source)
          || new RegExp(`const\\s+${helper}\\s*=`).test(source);
        // window.Foo is also a legitimate way to reach a shared helper.
        const viaWindow = new RegExp(`(global|window)\\.${helper}\\b`).test(source);
        if (!imported && !viaWindow) missing.push(`js/${name} calls ${helper}() without importing it from ${namespace}`);
      });
    });
  });

  t.equal(missing.length, 0, `no module calls an unimported shared helper. Missing: ${missing.join(' | ') || 'none'}`);

  // The specific pair, named so the failure is obvious if it ever regresses.
  const rental = read('js/rental.js');
  t.match(rental, /const \{ calculateClientQuote, quoteRows \} = global\.RevexPricing/,
    'js/rental.js imports both helpers it needs from RevexPricing');
  t.match(read('js/pricing.js'), /global\.RevexPricing = \{[^}]*quoteRows/,
    'and js/pricing.js really does export quoteRows');
  t.match(rental, /rows = quoteRows\(quote\);[\s\S]{0,400}?catch/,
    'a throw while painting the rows is caught, so a render fault can never blank the breakdown again');
});

t.done();

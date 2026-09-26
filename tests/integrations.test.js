/* ============================================================================
 * INTEGRATION REGRESSIONS  (tests/integrations.test.js)
 *
 * Each block below corresponds to a bug that shipped in 1.3.0. All four were
 * found by probing the real providers, not by reading the code, and every one
 * of them is invisible in review — they only show up as a dead feature at
 * runtime. They are pinned here so they cannot come back.
 *
 *   1. The assistant reported "not configured" with a perfectly valid Gemini
 *      key, because the endpoint URL was treated as a second mandatory secret.
 *   2. A Razorpay 401 (the SERVER's keys being wrong) was forwarded to the
 *      browser as our own 401, and the browser logged the customer out.
 *   3. Because real payments were gated on "keys are non-empty" rather than
 *      "keys work", a rejected key pair left no way to pay at all.
 *   4. chat-page.js called an undefined bare `api()`, so the history sidebar
 *      always rendered an error instead of conversations.
 * ========================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const { createSuite } = require('./harness');

const chatProvider = require('../backend/utils/chatProvider');
const gateway = require('../backend/utils/payments');

const t = createSuite('integration regressions');
const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ------------------------------------------------------------------- chat */

t.describe('assistant: a bare API key alone must configure the assistant', () => {
  // THE BUG: this returned configured:false and every message 503'd, even
  // though the key was valid and a direct call to Gemini returned 200.
  // The endpoint URL is a derivable constant, not a second mandatory secret.
  const legacyKey = chatProvider.providerConfig({ GEMINI_API_KEY: 'AIza' + 'B'.repeat(45) });
  t.equal(legacyKey.configured, true, 'the older AIza key format configures the assistant with no URL set');
  t.equal(legacyKey.derivedUrl, true, 'the endpoint is reported as derived, not user-supplied');
  t.equal(legacyKey.url, `${chatProvider.GEMINI_BASE}/models/gemini-2.5-flash:generateContent`, 'the official endpoint is built');
  t.equal(legacyKey.dialect, 'gemini');

  // Google also ships newer key shapes. Gating on a prefix rejected a key that
  // demonstrably worked, so the derivation must not inspect the key at all.
  // The fixture is deliberately built from an obviously fake prefix: a test key
  // that shared a prefix with a real one would be a partial disclosure in a diff.
  const modernKey = chatProvider.providerConfig({ GEMINI_API_KEY: `TESTKEY${'C'.repeat(46)}` });
  t.equal(modernKey.configured, true, 'a newer Google key format also works with no URL set');
  t.equal(modernKey.url, legacyKey.url, 'and resolves to the same endpoint');

  t.equal(chatProvider.providerConfig({ CHAT_API_KEY: 'sk-an-openai-style-key', CHAT_API_URL: 'https://api.openai.com/v1' }).dialect,
    'openai', 'an explicit URL still wins, so an OpenAI key is not sent to Google');
  t.equal(chatProvider.isGoogleAiKey('sk-abc'), false, 'an OpenAI-style key is recognised as not-Google');
  t.equal(chatProvider.isGoogleAiKey('TESTKEYxyz'), true);
  t.equal(chatProvider.isGoogleAiKey(''), false, 'no key is not-Google');

  t.equal(chatProvider.providerConfig({ CHAT_API_KEY: 'AIza' + 'B'.repeat(45), GEMINI_API_KEY: 'other' }).apiKey,
    'AIza' + 'B'.repeat(45), 'CHAT_API_KEY takes precedence over the legacy name');
  t.equal(chatProvider.providerConfig({ CHAT_API_KEY: 'AIza' + 'B'.repeat(45), CHAT_API_MODEL: 'gemini-2.0-flash' }).url,
    `${chatProvider.GEMINI_BASE}/models/gemini-2.0-flash:generateContent`, 'the model name reaches the derived URL');

  const noKey = chatProvider.providerConfig({});
  t.equal(noKey.configured, false, 'no key is cleanly unconfigured');
  t.match(noKey.problem, /API key/i, 'the reason names the missing key');
});

t.describe('assistant: endpoint completion', () => {
  const model = 'gemini-2.5-flash';
  t.equal(chatProvider.normaliseEndpoint(`${chatProvider.GEMINI_BASE}/models/x:generateContent`, model),
    `${chatProvider.GEMINI_BASE}/models/x:generateContent`, 'a full endpoint is left alone');
  t.equal(chatProvider.normaliseEndpoint('https://open.bigmodel.cn/api/paas/v4/chat/completions', model),
    'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'an OpenAI endpoint is left alone');
  t.equal(chatProvider.normaliseEndpoint(`${chatProvider.GEMINI_BASE}/models`, model),
    `${chatProvider.GEMINI_BASE}/models/gemini-2.5-flash:generateContent`, 'a /models base is completed');
  t.equal(chatProvider.normaliseEndpoint(`${chatProvider.GEMINI_BASE}/models/`, model),
    `${chatProvider.GEMINI_BASE}/models/gemini-2.5-flash:generateContent`, 'a trailing slash is handled');
  t.equal(chatProvider.normaliseEndpoint('https://api.example.com/v1', model),
    'https://api.example.com/v1/chat/completions', 'a bare API root becomes an OpenAI endpoint');
  t.equal(chatProvider.providerConfig({ CHAT_API_KEY: 'k', CHAT_API_URL: 'https://api.example.com/v1' }).dialect,
    'openai', 'and the dialect follows');

  t.equal(chatProvider.isTransportSafe('https://a.example.com'), true);
  t.equal(chatProvider.isTransportSafe('http://localhost:1234'), true, 'http is fine for a local provider');
  t.equal(chatProvider.isTransportSafe('http://a.example.com'), false);
  t.equal(chatProvider.providerConfig({ CHAT_API_KEY: 'k', CHAT_API_URL: 'http://a.example.com/v1' }).configured, false,
    'a plain-http remote endpoint is refused rather than leaking the key over the wire');

  const status = chatProvider.describeStatus({ CHAT_API_KEY: 'AIza' + 'B'.repeat(45) });
  t.equal(status.configured, true);
  t.equal(/AIza/.test(status.endpoint), false, 'the status payload never contains the key');
  t.match(status.endpoint, /:generateContent$/, 'a derived endpoint is reported as-is, since its key is added per request');

  // A URL pasted with the key already in the query string must be redacted.
  const pastedKey = 'AIza' + 'D'.repeat(45);
  const pasted = chatProvider.describeStatus({ CHAT_API_KEY: pastedKey, CHAT_API_URL: `https://host/v1beta/models/x:generateContent?key=${pastedKey}` });
  t.equal(/AIza/.test(pasted.endpoint), false, 'an embedded key is stripped from the reported endpoint');
  t.match(pasted.endpoint, /key=\*\*\*/, 'and replaced with a placeholder');
});

t.describe('assistant: provider failures are classified, not lumped together', () => {
  // An exhausted daily free-tier quota is the single most common real failure,
  // and it looks identical to an outage unless the message says otherwise.
  t.equal(chatProvider.classifyFailure(429, 'You exceeded your current quota, please check your plan and billing details.'), 'quota');
  t.equal(chatProvider.classifyFailure(429, 'Quota exceeded for metric: generate_content_free_tier_requests'), 'quota');
  t.equal(chatProvider.classifyFailure(429, 'Too Many Requests'), 'rateLimit');
  t.equal(chatProvider.classifyFailure(401, 'API key not valid'), 'credentials');
  t.equal(chatProvider.classifyFailure(403, 'Permission denied'), 'credentials');
  t.equal(chatProvider.classifyFailure(500, 'Internal error'), 'provider');

  t.equal(chatProvider.retryAfterSeconds('Please retry in 42.456715888s.'), 43, 'the provider retry hint is rounded up to whole seconds');
  t.equal(chatProvider.retryAfterSeconds('no hint here'), 0);

  t.match(chatProvider.userMessage('quota', 0), /quota/i, 'a quota problem says so');
  t.match(chatProvider.userMessage('quota', 0), /later today/i, 'and says retrying in a minute will not help');
  t.match(chatProvider.userMessage('rateLimit', 45), /45 seconds/, 'a rate limit gives the wait time the provider asked for');
  t.match(chatProvider.userMessage('rateLimit', 5), /5 seconds/, 'a short hint is reported honestly, not rounded up to a needlessly long wait');
  t.match(chatProvider.userMessage('rateLimit', 0), /30 seconds/, 'and a missing hint falls back to 30 seconds');
  t.match(chatProvider.userMessage('rateLimit', 43), /45 seconds/, 'a fractional hint is rounded up to a whole 5 seconds');
  t.match(chatProvider.userMessage('credentials', 0), /operator/i, 'a bad key names who has to fix it');
  t.match(chatProvider.userMessage('timeout', 0), /too long/i);
  t.match(chatProvider.userMessage('provider', 0), /temporarily unavailable/i);
  // No message may echo the provider's raw text, which can carry the key or
  // internal identifiers back to the browser.
  ['quota', 'rateLimit', 'credentials', 'timeout', 'provider'].forEach(kind => {
    const message = chatProvider.userMessage(kind, 30);
    t.equal(/[?&]key=|Bearer |AIza|api[_-]?key\s*[:=]\s*\S/i.test(message), false,
      `the ${kind} message carries no key material or raw provider text`);
  });

  const route = read('backend/routes/chat.js');
  t.match(route, /userMessage\(result\.kind, result\.retryAfter\)/, 'the route uses the classified message');
  t.match(route, /res\.set\('Retry-After'/, 'and tells the client when to retry');
  t.match(read('backend/utils/chatProvider.js'), /PLAIN TEXT ONLY/, 'the prompt forbids markdown, which the bubble would show literally');
});

/* --------------------------------------------------------------- razorpay */

t.describe('razorpay: a gateway 401 must never become our 401', () => {
  // THE BUG: 401 was passed through, and js/main.js reacts to a 401 on an
  // authenticated request by clearing the session and redirecting to login.
  // A server misconfiguration was therefore reported as the rider's fault.
  t.equal(gateway.mapUpstreamStatus(401), 502, 'a rejected key is a bad gateway, not a session problem');
  t.equal(gateway.mapUpstreamStatus(403), 502, 'a forbidden key is a bad gateway too');
  t.equal(gateway.mapUpstreamStatus(400), 400, 'a malformed request stays 400');
  t.equal(gateway.mapUpstreamStatus(429), 429, 'a rate limit is passed through honestly');
  t.equal(gateway.mapUpstreamStatus(500), 502);

  ['rides.js', 'bookings.js', 'payments.js', 'admin.js'].forEach(name => {
    const source = read(`backend/routes/${name}`);
    t.equal(/statusCode\)\s*===\s*401/.test(source), false, `${name} no longer maps a gateway 401 onto a 401`);
    t.equal(/res\.status\(401\)/.test(source), false, `${name} never answers 401 for a payment problem`);
  });

  t.match(gateway.CREDENTIALS_MESSAGE, /RAZORPAY_KEY_ID/, 'the message names the variable to fix');
  t.match(gateway.CREDENTIALS_MESSAGE, /RAZORPAY_KEY_SECRET/);
  t.match(gateway.CREDENTIALS_MESSAGE, /session is unaffected/i, 'it makes clear the rider is not at fault');
});

t.describe('razorpay: payment availability is probed, not assumed', () => {
  // THE BUG: the UI branched on "keys are non-empty", so a revoked key looked
  // healthy, opened a checkout that could never complete, and offered no
  // fallback. `usable` is the signal that fixes it.
  const route = read('backend/routes/payments.js');
  t.match(route, /await gateway\.checkHealth\(\)/, 'the config endpoint probes the gateway');
  t.match(route, /usable: health\.usable/, 'the probe result is reported to the client');
  t.match(route, /testModeAvailable: !health\.usable/, 'a test payment is offered whenever real payments cannot succeed');
  t.match(route, /Razorpay rejected the server keys/, 'the label says WHY, so an operator is not left guessing');

  const client = read('js/payment.js');
  t.equal(/config\.enabled/.test(client), false, 'js/payment.js does not branch on "keys are non-empty"');
  t.match(client, /config\.usable/, 'it branches on the probed state instead');
  t.match(client, /merged\.usable = /, 'it normalises the field for older servers');
  ['js/rides.js', 'js/rental.js'].forEach(file => {
    t.equal(/config\.enabled/.test(read(file)), false, `${file} does not branch on "keys are non-empty"`);
  });

  // The Razorpay window was hard-coded to an indigo used nowhere else in the
  // project, so the payment step looked like a different product.
  t.match(client, /theme:\s*\{\s*color: brandColour\(\)\s*\}/, 'the checkout takes the live brand colour');
  t.equal(/#[0-9a-f]{6}/i.test(read('js/payment.js')), true, 'and the fallback is still a defined hex');
});

t.describe('razorpay: id validation accepts real ids', () => {
  // Razorpay tokens have been observed both with and without an underscore. The
  // old `[A-Za-z0-9]+` pattern rejected a legitimate payment outright.
  const source = read('backend/utils/payments.js');
  t.match(source, /\^order_\[A-Za-z0-9_\]\+\$/, 'order ids allow an underscore in the token');
  t.match(source, /\^pay_\[A-Za-z0-9_\]\+\$/, 'payment ids allow an underscore in the token');
});

/* ---------------------------------------------------------------- chat ui */

t.describe('chat page: no undefined globals', () => {
  // THE BUG: a bare `api(...)` with no destructure threw ReferenceError, which
  // the file's own try/catch swallowed into a visible error bubble.
  const source = read('js/chat-page.js');
  const destructure = /const\s*\{\s*api\s*,\s*escapeHtml\s*\}\s*=\s*R/.exec(source);
  t.ok(destructure, 'api comes from the shared namespace');
  t.ok(source.indexOf('api(') > destructure.index, 'and it is bound before the first call, so no call runs unbound');
  t.equal(/\bwindow\.api\b|global\.api\b/.test(source), false, 'no reliance on an api global');

  [['js/chat-page.js', 'host: hostBox'], ['js/admin.js', 'host }']].forEach(([file, marker]) => {
    const page = read(file);
    t.match(page, new RegExp(marker.replace(/[{}]/g, '\\$&')), `${file} asks the widget to own the layout`);
    t.equal(/panel\.style\.(position|width|height|boxShadow|border)/.test(page), false,
      `${file} does not override the panel's own layout rules inline`);
  });
  t.match(read('js/chat.js'), /panel\.dataset\.host = 'page'/, 'the widget marks a page-hosted panel');
});

t.describe('chat ui: it follows the theme and cannot go white-on-white again', () => {
  const widget = read('js/chat.js');
  t.equal(/#[0-9a-f]{3,8}\b/i.test(widget), false, 'the widget hard-codes no hex colour');
  t.equal(/rgb\(|hsl\(/.test(widget), false, 'and no rgb/hsl colour either');

  const css = read('css/chat.css');
  // Comments are stripped first: this file's own header explains the original
  // bug by naming the token that caused it, and prose must not be read as code.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const used = [...new Set((code.match(/var\(\s*(--[a-z0-9-]+)/g) || []).map(v => v.replace(/var\(\s*/, '')))];

  // Real tokens owned by the app shell. Everything else must be a chat token.
  // An invented name (`--card`, `--accent`, `--rvx-line`) is undefined, so
  // `var()` silently falls back to its second argument — which is how the panel
  // ended up white text on a white background in dark mode.
  const APP_TOKENS = ['surface', 'brand', 'line'];
  t.ok(used.length > 8, `the stylesheet uses custom properties (${used.length} found)`);
  used
    .filter(token => !APP_TOKENS.some(app => token === `--${app}`))
    .forEach(token => t.match(token, /^--revex-chat-/, `${token} is a real chat token, not an invented one`));

  // Every token that IS used must also be defined here, or in the app shell.
  used.forEach(token => {
    const appOwned = APP_TOKENS.some(app => token === `--${app}`);
    if (appOwned) {
      const shell = read('css/style.css');
      t.match(shell, new RegExp(`${token}\\s*:`), `${token} is defined by the app shell`);
      return;
    }
    t.match(code, new RegExp(`${token}\\s*:`), `${token} is defined here, not only referenced`);
  });
  t.match(code, /\[data-theme="dark"\][\s\S]*?--revex-chat-surface:\s*#[0-9a-f]{3}/i, 'dark mode redefines the surface token');
  t.match(code, /\.dark\s+\.rvx-chat-panel/, 'the .dark class is honoured as well as the data attribute');
});

t.describe('chat ui: the panel is positioned like the reference', () => {
  const css = read('css/chat.css');
  const panel = /\.rvx-chat-panel\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  const launcher = /\.rvx-chat-launcher\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  const bottom = rule => Number(/bottom:\s*(\d+)px/.exec(rule)[1]);
  // THE BUG: the panel was at bottom:18px, so it sat ON TOP of the launcher.
  t.ok(bottom(panel) > bottom(launcher), 'the panel sits above the launcher, never on top of it');
  t.match(panel, /width:\s*min\(390px/, 'the panel keeps the reference width');
  t.match(panel, /height:\s*min\(610px/, 'the panel keeps the reference height');
  t.match(css, /\.rvx-chat-panel\.is-open\s*\{/, 'opening is a class, so it can animate');
  t.match(read('js/chat.js'), /classList\.add\('is-open'\)/, 'the widget toggles that class');
  t.equal(/panel\.hidden\s*=/.test(read('js/chat.js')), false, 'the hidden attribute is gone, so the animation is not skipped');
});

t.describe('chat ui: the reference furniture is all present', () => {
  const js = read('js/chat.js');
  t.match(js, /Ask REVEX/, 'the launcher keeps the reference label');
  t.match(js, />RX</, 'the header keeps the RX avatar');
  t.match(js, /Never share OTP, CVV, PIN, passwords or secret keys/, 'the safety reminder is kept');
  t.match(js, /rvx-chat-suggest/, 'the suggestion chips are kept');
  t.match(js, /key === 'Escape'/, 'Escape closes the panel');
  t.match(js, /aria-live="polite"/, 'the transcript announces new messages');
  t.match(js, /aria-expanded/, 'the launcher reports its state to assistive tech');
});

t.done();

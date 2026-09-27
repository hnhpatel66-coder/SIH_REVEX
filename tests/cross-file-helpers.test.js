#!/usr/bin/env node
/**
 * NO DUPLICATE OR SHADOWED HELPERS  (tests/cross-file-helpers.test.js)
 *
 * Every page loads js/main.js, which creates a set of shared helpers
 * (`api`, `escapeHtml`, `formatMoney`, `statusBadge`, `showToast`, ...). A page
 * script that declares a function with one of those names SHADOWS the shared
 * one for itself - and because the shadow only exists in that file, the same
 * control renders differently on that page and nowhere else.
 *
 * That is not hypothetical: js/booking.js declared its own `statusBadge()` and
 * `bookingStatusLabel()`, so a "pending owner" badge looked one way on My
 * Bookings and another way on the owner dashboard.
 *
 * These checks fail on any redeclaration, so the class of bug cannot come back.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./harness');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');
const t = createSuite('cross-file helpers');

/** Helpers owned by js/main.js. A page script must not redeclare any of them. */
const SHARED = [
  'api', 'escapeHtml', 'formatMoney', 'formatDate', 'formatDateTime', 'assetUrl',
  'getToken', 'getStoredUser', 'setSession', 'clearSession', 'friendlyError',
  'requireLogin', 'requireRole', 'currentPage', 'currentHash', 'isPublicSite', 'roleHome',
  'showModal', 'closeModal', 'showToast', 'confirmAction',
  'statusBadge', 'statusLabel', 'imageOrInitials', 'STATUS_LABELS', 'STATUS_TONE',
  'buildNav', 'bindMenu', 'applyBrand', 'loadNotifications', 'resolveApiBase',
  'downloadAgreement', 'API_BASE', 'BRAND', 'CURRENCY', 'NAV_CONFIG'
];

/**
 * Namespaces published by the new modules. Only the exported `window.*` names
 * are reserved: a private helper of one script is that script's business, and
 * reserving more than that would forbid two screens from both needing, say, a
 * `refreshQuote()` of their own.
 */
const MODULES = {
  'js/payment.js': ['RevexPay'],
  'js/chat.js': ['RevexChat'],
  'js/admin.js': ['RevexAdmin'],
  'js/rides.js': ['RevexRides'],
  'js/booking.js': ['RevexBookings']
};

const files = fs.readdirSync(JS).filter(name => name.endsWith('.js') && name !== 'main.js');

/** Top-level declarations only: indented ones are inside a function scope. */
function topLevelNames(source) {
  const names = new Set();
  const patterns = [
    /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) names.add(match[1]);
  }
  return names;
}

t.describe('no page script redeclares a shared helper', () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(JS, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const declared = topLevelNames(source);
    const clashes = SHARED.filter(name => declared.has(name));
    t.equal(clashes.length, 0, `${file} does not redeclare ${clashes.length ? clashes.join(', ') : 'any shared helper'}`);
  }
});

t.describe('no page script redeclares another module\'s namespace', () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(JS, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const declared = topLevelNames(source);
    for (const [owner, names] of Object.entries(MODULES)) {
      if (owner === `js/${file}`) continue;
      const clashes = names.filter(name => declared.has(name));
      t.equal(clashes.length, 0, `${file} does not redeclare ${clashes.length ? clashes.join(', ') : `anything from ${owner}`}`);
    }
  }
});

t.describe('each page script is wrapped so it cannot leak globals', () => {
  // An unwrapped script puts every one of its helpers on window, which is how
  // two pages end up fighting over the same global.
  for (const file of files) {
    const source = fs.readFileSync(path.join(JS, file), 'utf8');
    const wrapped = /\(function\s*\(\s*(?:global|window)\s*\)[\s\S]*\}\)\((?:window|globalThis)\);/.test(source.trim())
      || /^import\s/m.test(source)
      || /^(const|let)\s+\{[\s\S]*?\}\s*=\s*window\./m.test(source);
    t.equal(wrapped, true, `${file} is wrapped in an IIFE or uses module scope`);
  }
});

t.describe('the shared namespace exposes what the pages use', () => {
  const main = fs.readFileSync(path.join(JS, 'main.js'), 'utf8');
  const namespace = main.slice(main.indexOf('window.REVEX = {'));
  for (const name of SHARED) {
    if (['STATUS_LABELS', 'STATUS_TONE', 'NAV_CONFIG', 'bindMenu', 'applyBrand', 'loadNotifications', 'resolveApiBase', 'currentHash', 'isPublicSite', 'friendlyError'].includes(name)) continue;
    t.match(namespace, new RegExp(`\\b${name}\\b`), `window.REVEX exposes ${name}`);
  }
  // The globals older page scripts rely on are still published.
  for (const name of ['statusBadge', 'imageOrInitials', 'showToast', 'confirmAction']) {
    t.match(main, new RegExp(`window\\.${name} = ${name};`), `${name} is also published as a global`);
  }
});

t.describe('every page loads the shared layer in the right order', () => {
  const pages = fs.readdirSync(ROOT).filter(name => name.endsWith('.html'));
  const order = ['js/theme.js', 'js/confirm-delete.js', 'js/main.js', 'js/payment.js', 'js/chat.js'];
  for (const page of pages) {
    const source = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const positions = order.map(src => source.indexOf(`<script src="${src}"></script>`));
    t.ok(positions.every(position => position >= 0), `${page} loads every shared script`);
    const sorted = positions.every((position, index) => index === 0 || position > positions[index - 1]);
    t.equal(sorted, true, `${page} loads the shared scripts in order`);
    // The page's own script must come last so window.REVEX already exists.
    const own = [...source.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]).filter(src => !order.includes(src));
    if (own.length) {
      const lastPosition = source.lastIndexOf(`<script src="${own[own.length - 1]}"></script>`);
      t.ok(lastPosition > positions[4], `${page} loads ${own[own.length - 1]} after the shared layer`);
    }
  }
});

t.done();

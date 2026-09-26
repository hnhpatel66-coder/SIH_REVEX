#!/usr/bin/env node
/**
 * RESPONSIVE + ACCESSIBILITY  (tests/responsive-a11y.test.js)
 *
 * Static checks over the shipped HTML and CSS. They cannot replace testing on a
 * real phone, but they do catch the regressions that actually happened here:
 * a control with no label, a click handler on a non-interactive element, a
 * viewport meta removed by an edit, and a stylesheet that was appended in the
 * wrong order and therefore never applied.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./harness');

const ROOT = path.join(__dirname, '..');
const t = createSuite('responsive and accessibility');

const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const pages = fs.readdirSync(ROOT).filter(name => name.endsWith('.html'));
const ui = read('css/revex-ui.css');
const chat = read('css/chat.css');

/* ------------------------------------------------------------------ pages */

t.describe('every page declares a viewport and a language', () => {
  for (const page of pages) {
    const html = read(page);
    t.match(html, /<meta name="viewport" content="width=device-width/, `${page} has a responsive viewport`);
    t.match(html, /<html lang="en"/, `${page} declares a document language`);
    t.match(html, /<title>[^<]+<\/title>/, `${page} has a non-empty title`);
    t.match(html, /<meta name="description" content="[^"]{20,}"/, `${page} has a meaningful description`);
    t.match(html, /<html lang="en" data-theme="light">/, `${page} defaults to light so there is no flash`);
    t.match(html, /localStorage\.getItem\('revexTheme'\)/, `${page} applies the stored theme before first paint`);
  }
});

t.describe('every page loads the stylesheets in the same order', () => {
  const order = ['css/style.css', 'css/navbar.css', 'css/cards.css', 'css/responsive.css', 'css/theme.css', 'css/revex-ui.css', 'css/chat.css'];
  for (const page of pages) {
    const html = read(page);
    const positions = order.map(href => html.indexOf(`href="${href}"`));
    t.ok(positions.every(position => position >= 0), `${page} loads every stylesheet`);
    t.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]), `${page} loads the stylesheets in the canonical order`);
  }
});

t.describe('the mobile navigation has an accessible name', () => {
  for (const page of pages) {
    const html = read(page);
    if (!html.includes('class="nav-links"')) continue;
    t.match(html, /class="menu-btn"[^>]*aria-label="[^"]+"/, `${page} gives the menu button an aria-label`);
    t.match(html, /<nav class="nav"|<nav class="admin-topbar/, `${page} wraps navigation in a nav element`);
  }
  t.match(read('js/main.js'), /menu\.setAttribute\('aria-expanded'/, 'the menu button reports its expanded state');
  t.match(read('js/main.js'), /Escape/, 'Escape closes the mobile menu');
  t.match(read('css/responsive.css'), /@media/, 'the base responsive stylesheet has media queries');
});

/* --------------------------------------------------------------- controls */

t.describe('interactive controls are real controls', () => {
  for (const page of pages) {
    const html = read(page);
    // A div or span with a click handler is not focusable and not announced as
    // a button. Any such element must carry a role and a tabindex.
    const clickables = [...html.matchAll(/<(div|span|li|p)\b[^>]*\bonclick=/g)];
    t.equal(clickables.length, 0, `${page} has no click handler on a non-interactive element (${clickables.length} found)`);
    // Every <button> in the markup declares its type, so a control that is later
    // moved inside a form cannot silently start submitting it.
    const untyped = [...html.matchAll(/<button\b(?![^>]*\btype=)[^>]*>/g)];
    t.equal(untyped.length, 0, `${page} gives every button an explicit type (${untyped.length} missing)`);
  }
});

t.describe('form controls have labels', () => {
  for (const page of pages) {
    const html = read(page);
    const ids = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
    for (const id of ids) {
      const tag = (html.match(new RegExp(`<(?:input|select|textarea)[^>]*id="${id}"[^>]*>`)) || [''])[0];
      const labelled = new RegExp(`<label[^>]*for="${id}"`).test(html)
        || /aria-label(edby)?=/.test(tag)
        || /type="(hidden|checkbox)"/.test(tag);
      t.equal(labelled, true, `${page}: #${id} has an accessible name`);
    }
  }
  // The consolidated field pattern must use a real <label for>, not a <span>.
  for (const page of ['offer-ride.html', 'ride-details.html', 'profile.html', 'bookings.html', 'admin.html']) {
    t.notMatch(read(page), /<div class="rvx-field"><span>[^<]*<\/span>\s*<(?:input|select|textarea)/,
      `${page} associates every rvx-field label with its control`);
  }
  t.match(ui, /\.rvx-field > span, \.rvx-field > label/, 'the UI layer styles both label forms identically');
  t.match(ui, /:focus-visible/, 'the UI layer defines a visible focus ring');
  t.match(read('js/chat.js'), /<label class="sr-only" for="revexChatInput">/, 'the chat input has a screen-reader label');
});

t.describe('dynamic content announces itself', () => {
  t.match(read('js/chat.js'), /role="log"/, 'the chat transcript is a live log');
  t.match(read('js/chat.js'), /aria-live="polite"/, 'new chat messages are announced politely');
  t.match(read('admin.html'), /id="adminMessage" class="form-message" role="status"/, 'admin feedback is a status region');
  t.match(read('js/main.js'), /setAttribute\('role', 'status'\)[\s\S]{0,120}setAttribute\('aria-live', 'polite'\)/, 'toasts are a polite status region');
  t.match(read('js/rides.js'), /role="dialog" aria-modal="true"/, 'the payment dialog is modal and labelled');
  t.match(read('js/main.js'), /role="dialog" aria-modal="true"/, 'the confirm dialog is modal and labelled');
});

/* ------------------------------------------------------------- responsive */

t.describe('the UI layer handles small screens', () => {
  t.match(ui, /@media \(max-width: 640px\)/, 'there is a phone breakpoint');
  t.match(ui, /@media \(max-width: 900px\)/, 'there is a tablet breakpoint');
  t.match(ui, /overflow-x: auto/, 'wide tables scroll instead of overflowing the page');
  t.match(ui, /min-width: \d+px;/, 'the table minimum width is what triggers the scroll, not the page');
  t.match(ui, /prefers-reduced-motion: reduce/, 'animation is disabled for users who ask for it');
  t.match(ui, /:focus-visible/, 'focus is visible for keyboard users');
  // The layer was originally written against --card/--text/--accent, which the
  // theme does not define. The silent `var(--wrong, #fff)` fallback looked fine
  // in light mode and made the chat panel white-on-white in dark mode.
  t.match(ui, /color-mix\(in srgb, var\(--ink\)/, 'the UI layer derives its lines from the theme ink token');
  t.notMatch(ui, /var\(--card\b|var\(--text\b|var\(--accent\b/, 'the UI layer uses no token the theme does not define');
  t.match(ui, /--rvx-accent: var\(--brand/, 'the accent is the theme brand colour');
  // The chat widget keeps its own palette (the reference design is green, the
  // app brand is teal), but every one of its tokens must be declared for BOTH
  // themes. A token defined in only one block is what made the panel render
  // white text on a white background in dark mode.
  const chatCode = chat.replace(/\/\*[\s\S]*?\*\//g, '');
  const darkStart = chatCode.search(/\[data-theme="dark"\]|\.dark\s/);
  t.ok(darkStart > 0, 'the chat stylesheet has a dark-mode block');
  const chatTokens = [...new Set([...chatCode.matchAll(/(--revex-chat-[a-z0-9-]+)\s*:/g)].map(m => m[1]))];
  t.ok(chatTokens.length > 8, `the chat palette has its own tokens (${chatTokens.length} found)`);
  chatTokens.forEach(token => {
    t.match(chatCode.slice(0, darkStart), new RegExp(`${token}\\s*:`), `${token} has a light value`);
    t.match(chatCode.slice(darkStart), new RegExp(`${token}\\s*:`), `${token} has a dark value too`);
  });
  t.notMatch(chatCode, /--rvx-(line|card|text|accent)\s*:/, 'no token is invented outside the documented palette');
  t.match(chat, /color: var\(--revex-chat-text\)/, 'the chat panel text is its own themed ink token');
  t.match(chat, /background: var\(--revex-chat-surface\)/, 'the chat panel background is its own themed surface token');
});

t.describe('the chat widget fits a phone', () => {
  t.match(chat, /@media \(max-width: 640px\)/, 'the chat panel has a phone breakpoint');
  // 32px, matching the reference: the panel keeps a 10px gutter on each side.
  t.match(chat, /width: min\(390px, calc\(100vw - 32px\)\)/, 'the chat panel never exceeds the viewport');
  t.match(chat, /prefers-reduced-motion: reduce/, 'chat animation respects reduced-motion');
  t.match(chat, /\.rvx-chat-launcher/, 'there is a launcher so the assistant is reachable on every page');
});

t.describe('nothing depends on a fixed pixel width', () => {
  for (const page of ['find-ride.html', 'ride-details.html', 'offer-ride.html', 'ride-requests.html', 'chat.html', 'admin.html', 'bookings.html', 'list-vehicle.html']) {
    const html = read(page);
    t.notMatch(html.replace(/<meta name="viewport"[^>]*>/, ''), /width="\d{4,}"/, `${page} sets no fixed 1000px+ width on a container`);
  }
  t.match(read('css/revex-ui.css'), /max-width: \d+px;/, 'the shell has a max width and auto side margins');
});

t.describe('the owner summary tables are scrollable, not clipped', () => {
  t.match(ui, /\.rvx-table-wrap \{[\s\S]*?overflow-x: auto/, 'the table wrapper scrolls horizontally on a narrow screen');
  t.match(ui, /\.rvx-table th \{[\s\S]*?position: sticky/, 'the header row stays visible while scrolling');
  t.match(ui, /@media \(max-width: 640px\)[\s\S]*?\.rvx-btn \{ width: 100%/, 'action buttons go full width on a phone');
});

t.done();

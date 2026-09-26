#!/usr/bin/env node
/**
 * GIVE EVERY BUTTON AN EXPLICIT TYPE  (scripts/sync-button-types.js)
 *
 * `<button>` defaults to `type="submit"`. That is harmless for a button that
 * lives outside a form, but it means a single later edit that moves a control
 * inside a form silently starts submitting it - clicking "Cancel" on the
 * booking panel would post the form instead of closing the dialog.
 *
 * This script makes the intent explicit everywhere. It is idempotent.
 *
 * Usage:
 *   node scripts/sync-button-types.js
 *   node scripts/sync-button-types.js --check
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

/**
 * A submit button must be able to stay a submit button, so the ones that
 * legitimately submit are listed by a stable marker: the exact button text.
 */
const SUBMIT_TEXTS = new Set(['submit', 'submit review', 'save profile', 'create admin']);

function normalise(text) {
  return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function fix(html, file) {
  return html.replace(/<button\b([^>]*)>/g, (match, attributes) => {
    if (/\btype\s*=/.test(attributes)) return match;
    const text = normalise(html.slice(match.index + match.length, match.index + match.length + 120).split(/<\/(?:button|a|div)>/)[0]);
    const type = SUBMIT_TEXTS.has(text) ? 'submit' : 'button';
    return `<button${attributes} type="${type}">`;
  });
}

const pages = fs.readdirSync(ROOT).filter(name => name.endsWith('.html'));
const problems = [];
let changed = 0;

for (const page of pages) {
  const file = path.join(ROOT, page);
  const original = fs.readFileSync(file, 'utf8');
  const next = fix(original, page);
  if (next === original) continue;
  if (CHECK_ONLY) problems.push(page);
  else { fs.writeFileSync(file, next); changed += 1; console.log(`updated ${page}`); }
}

if (CHECK_ONLY) {
  if (problems.length) {
    console.error('These pages have buttons without an explicit type:');
    problems.forEach(page => console.error(`  - ${page}`));
    console.error('\nRun:  node scripts/sync-button-types.js');
    process.exit(1);
  }
  console.log(`Every button has an explicit type across ${pages.length} page(s).`);
} else {
  console.log(changed ? `Updated ${changed} of ${pages.length} page(s).` : `All ${pages.length} page(s) already correct.`);
}

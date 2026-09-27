#!/usr/bin/env node
/**
 * ASSOCIATE EVERY FIELD LABEL  (scripts/sync-field-labels.js)
 *
 * The consolidated UI layer renders a field as
 *
 *     <div class="rvx-field">
 *       <span>Label text</span>
 *       <input id="something">
 *     </div>
 *
 * A `<span>` is not a label, so a screen reader announces the input as
 * "edit text, blank" and clicking the text does not focus the control. This
 * script rewrites that pattern to a real `<label for="...">`, and gives the two
 * bare search inputs in the admin panel an `aria-label`.
 *
 * Idempotent. Usage:
 *   node scripts/sync-field-labels.js
 *   node scripts/sync-field-labels.js --check
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

/** Search inputs that have a placeholder but no visible label. */
const ARIA_LABELS = {
  ownerSearch: 'Search owners by name, email or phone',
  agreementSearch: 'Search agreements by id, renter, owner or vehicle'
};

function fix(html) {
  let next = html;

  // <div class="rvx-field">[\s\S]*?<span>Text</span>[\s\S]*?<control id="x" ...
  // -> the same, with a real <label for="x">. The `[\s\S]*?` makes it work for
  // the multi-line variant where a <small> hint sits between the label and the
  // control, and the lazy match stops at the FIRST control so a label is never
  // associated with the wrong field.
  next = next.replace(
    /(<div class="rvx-field">[\s\S]{0,400}?)<span>([^<]{1,80})<\/span>([\s\S]{0,400}?<(?:input|select|textarea)\b[^>]*\bid="([^"]+)")/g,
    (match, open, text, gap, id) => `${open}<label for="${id}">${text}</label>${gap}`
  );

  // The .rvx-field--row checkbox variant: <span> wraps a checkbox + its text.
  next = next.replace(
    /<label class="rvx-field rvx-field--row"><input type="checkbox"([^>]*?)id="([^"]+)"([^>]*)><span>([^<]{1,120})<\/span><\/label>/g,
    (match, before, id, after, text) =>
      `<label class="rvx-field rvx-field--row" for="${id}"><input type="checkbox"${before}id="${id}"${after}><span>${text}</span></label>`
  );

  // Give the remaining labelled controls a name.
  for (const [id, label] of Object.entries(ARIA_LABELS)) {
    const pattern = new RegExp(`(<(?:input|select|textarea)\\b(?![^>]*aria-label)[^>]*\\bid="${id}"[^>]*)>`);
    next = next.replace(pattern, `$1 aria-label="${label}">`);
  }

  return next;
}

const pages = fs.readdirSync(ROOT).filter(name => name.endsWith('.html'));
const problems = [];
let changed = 0;

for (const page of pages) {
  const file = path.join(ROOT, page);
  const original = fs.readFileSync(file, 'utf8');
  const next = fix(original);
  if (next === original) continue;
  if (CHECK_ONLY) problems.push(page);
  else { fs.writeFileSync(file, next); changed += 1; console.log(`updated ${page}`); }
}

if (CHECK_ONLY) {
  if (problems.length) {
    console.error('These pages have unassociated field labels:');
    problems.forEach(page => console.error(`  - ${page}`));
    process.exit(1);
  }
  console.log(`Every field label is associated across ${pages.length} page(s).`);
} else {
  console.log(changed ? `Updated ${changed} of ${pages.length} page(s).` : `All ${pages.length} page(s) already correct.`);
}

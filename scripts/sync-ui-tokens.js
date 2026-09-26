#!/usr/bin/env node
/**
 * ALIGN THE UI LAYER WITH THE REAL THEME TOKENS
 * (scripts/sync-ui-tokens.js)
 *
 * The consolidated UI layer was written against `--card`, `--text` and
 * `--accent`. The theme in css/style.css and css/theme.css actually defines
 * `--surface`, `--ink` and `--brand`.
 *
 * A `var(--card, #fff)` whose variable does not exist silently falls back to
 * `#fff`, so the layer looked correct in LIGHT mode and became unreadable in
 * DARK mode: a white card with light text. That is exactly the class of bug this
 * script exists to make impossible.
 *
 * It rewrites the token names and then FAILS if the layer still references a
 * variable the theme does not define.
 *
 * Usage:
 *   node scripts/sync-ui-tokens.js
 *   node scripts/sync-ui-tokens.js --check
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');
const LAYER = ['css/revex-ui.css', 'css/chat.css'];

/**
 * css/chat.css is allowed its own literal palette, and is then held to a
 * STRICTER rule instead (see `checkSelfContainedPalette`).
 *
 * Why the exception is legitimate: the chat widget's identity is a green
 * gradient, taken from the reference design. The app's own brand is teal
 * (`--brand: #0f766e`). Forcing the widget onto `--brand` would change the design
 * the reference specifies, and forcing its green through `--success` cannot
 * reproduce the reference's exact tone. So the palette stays literal — but it
 * must be complete and it must be declared for BOTH themes, which is the check
 * that actually prevents the white-on-white regression.
 */
const SELF_CONTAINED = { 'css/chat.css': '--revex-chat-' };

/**
 * Every `--revex-chat-*` token must be defined in the light `:root` block AND
 * again inside the dark block. A token defined in only one of them is the exact
 * failure this project shipped once: the panel kept its light background in dark
 * mode and the text became invisible.
 */
function checkSelfContainedPalette(file, prefix, source) {
  const darkStart = source.search(/\[data-theme="dark"\]|\.dark\s/);
  if (darkStart < 0) return [`${file} has no dark-mode block, so its palette cannot follow the theme`];
  const light = source.slice(0, darkStart);
  const dark = source.slice(darkStart);

  const tokens = new Set();
  for (const match of source.matchAll(new RegExp(`(${prefix}[a-z0-9-]+)\\s*:`, 'gi'))) tokens.add(match[1]);
  const problems = [];
  for (const token of tokens) {
    if (!new RegExp(`${token}\\s*:`).test(light)) problems.push(`${file} defines ${token} only in the dark block`);
    if (!new RegExp(`${token}\\s*:`).test(dark)) problems.push(`${file} defines ${token} only in the light block`);
  }
  if (!tokens.size) problems.push(`${file} declares no ${prefix}* tokens, so it cannot be theme-independent`);
  return problems;
}

/** Wrong name -> the token the theme actually defines. */
const RENAMES = [
  ['--card', '--surface'],
  ['--text', '--ink'],
  ['--accent', '--brand']
];

/**
 * Every custom property that is actually available: the theme tokens, plus the
 * ones the layer declares in its own `:root`. Reading the real files (rather
 * than a hard-coded list) means a renamed or removed token is caught at once.
 */
function availableTokens() {
  const defined = new Set();
  for (const file of ['css/style.css', 'css/theme.css', ...LAYER]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(match[1]);
  }
  return defined;
}

function rewrite(source) {
  let next = source;
  for (const [from, to] of RENAMES) {
    // Only whole custom-property names, and never one already prefixed rvx-.
    next = next.replace(new RegExp(`var\\(\\s*${from}(?![a-z0-9-])`, 'g'), `var(${to}`);
    next = next.replace(new RegExp(`(${from})(?![a-z0-9-])`, 'g'), to);
  }
  return next;
}

/** Removes /* ... *\/ and // comments so they are not checked as code. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The only literal colours allowed outside a `var(--token, fallback)`.
 *   #fff     white text on a brand-coloured button
 *   #020617  the near-black scrim behind a modal. A scrim dims whatever is
 *            behind it, so it must stay near-black in BOTH themes - a token
 *            would invert with the page and make the dialog unreadable.
 */
const ALLOWED_HEX = new Set(['#fff', '#020617']);

const defined = availableTokens();
let changed = 0;
const problems = [];

for (const file of LAYER) {
  const full = path.join(ROOT, file);
  const original = fs.readFileSync(full, 'utf8');
  const next = rewrite(original);
  if (next !== original) {
    if (CHECK_ONLY) { problems.push(`${file} still uses a token the theme does not define`); continue; }
    fs.writeFileSync(full, next);
    changed += 1;
    console.log(`updated ${file}`);
  }
  // The check: every `var(--x` in the layer must be a real token. Comments are
  // stripped first, because the documentation above deliberately names a
  // non-existent token as an example of the bug.
  const source = stripComments(fs.readFileSync(full, 'utf8'));
  for (const match of source.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    if (!defined.has(match[1])) problems.push(`${file} references ${match[1]}, which no stylesheet defines`);
  }
  // A hard-coded colour that is NOT a `var(--token, fallback)` bypasses the
  // theme and is the thing that made this layer unreadable in dark mode. Files
  // with their own documented palette are exempt here and checked harder below.
  if (!SELF_CONTAINED[file]) {
    const withoutFallbacks = source.replace(/var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-f]{3,8}\s*\)/gi, 'var(--token)');
    for (const match of withoutFallbacks.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
      if (!ALLOWED_HEX.has(match[0].toLowerCase())) {
        problems.push(`${file} hard-codes the colour ${match[0]} instead of using a theme token`);
      }
    }
  }
}

/*
 * Second pass over the self-contained files. Runs after the loop above so the
 * shared layer is still held to the strict "theme tokens only" rule.
 */
for (const [file, prefix] of Object.entries(SELF_CONTAINED)) {
  const source = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  // A self-contained palette is allowed to be literal; skip the hex complaint
  // for it, but require it to be complete in both themes.
  for (const problem of checkSelfContainedPalette(file, prefix, source)) problems.push(problem);
  for (const match of source.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    const token = match[1];
    if (token.startsWith(prefix)) continue;         // its own palette
    if (defined.has(token)) continue;               // a real theme token
    problems.push(`${file} references ${token}, which no stylesheet defines`);
  }
}

if (problems.length) {
  console.error('The UI layer and the theme disagree:');
  [...new Set(problems)].forEach(problem => console.error(`  - ${problem}`));
  console.error('\nRun:  node scripts/sync-ui-tokens.js');
  process.exit(1);
}
console.log(CHECK_ONLY
  ? 'The UI layer only uses tokens the theme defines.'
  : (changed ? `Updated ${changed} file(s).` : 'The UI layer already uses the right tokens.'));

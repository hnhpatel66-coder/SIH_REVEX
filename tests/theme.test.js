// Static check of the theme layer: verifies the dark token block and that the
// selectors which must flip surfaces are all present. Catches the class of
// bug where a hard-coded light colour is never overridden.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'theme.css'), 'utf8');
const base = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
const themeJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'theme.js'), 'utf8');

let pass = 0; const failures = [];
function check(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`); }
  catch (e) { failures.push({ label, message: e.message }); console.log(`  FAIL ${label}\n       ${e.message}`); }
}

console.log('\nTheme layer checks\n');

check('defines a dark theme block', () => {
  assert.match(css, /\[data-theme="dark"\]\s*\{/);
});
check('defines light tokens on :root', () => {
  assert.match(css, /:root\s*\{[\s\S]*--page-bg/);
});
check('every token set on :root also exists in the dark block', () => {
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkBlock = css.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(rootBlock && darkBlock, 'token blocks not found');
  const tokens = [...rootBlock[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]);
  const missing = tokens.filter(t => !new RegExp(`${t}\\s*:`).test(darkBlock[1]));
  assert.deepEqual(missing, [], `dark block is missing overrides for: ${missing.join(', ')}`);
});

check('flips the hard-coded light surfaces found in the base sheet', () => {
  // Surfaces the reference stylesheet hard-codes to white / near-white.
  const mustFlip = [
    '.booking-panel', '.auth-card', '.detail-panel', '.stat-card', '.request-card',
    '.moderation-card', '.booking-row', '.modal-box', '.terms-grid article',
    '.agree-card', '.rule', '.cost-box', '.empty', '.field input', '.field select',
    '.field textarea', '.btn-outline', '.tab', '.filter-chip', '.request-facts span',
    '.detail-facts > div', '.document-item', '.notice'
  ];
  const missing = mustFlip.filter(sel => !css.includes(`[data-theme="dark"] ${sel}`));
  assert.deepEqual(missing, [], `no dark override for: ${missing.join(', ')}`);
});

check('redefines components that predate the adopted stylesheet', () => {
  for (const sel of ['.admin-search', '.agreement-row', '.is-highlighted', '.notice-error']) {
    assert.ok(css.includes(sel), `theme.css lost .${sel.replace('.', '')}`);
  }
});

check('styles the theme toggle', () => {
  assert.match(css, /\.theme-toggle\s*\{/);
  assert.match(css, /\.theme-toggle \.thumb\s*\{/);
  assert.match(css, /\.theme-choice button\s*\{/);
});

check('keeps the accent link and delete-dialog styles', () => {
  assert.match(css, /\.accent-link\s*\{/);
  assert.match(css, /\.confirm-card \.danger-note\s*\{/);
  assert.match(css, /\.confirm-card \.impact-list\s*\{/);
});

check('respects prefers-reduced-motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

check('every page loads theme.css and theme.js', () => {
  const root = path.join(__dirname, '..');
  const pages = fs.readdirSync(root).filter(f => f.endsWith('.html') && f !== 'theme-probe.html');
  const bad = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    if (!html.includes('css/theme.css')) bad.push(`${page}: missing theme.css`);
    if (!html.includes('js/theme.js')) bad.push(`${page}: missing theme.js`);
    if (!html.includes('revexTheme')) bad.push(`${page}: missing the no-flash snippet`);
  }
  assert.deepEqual(bad, []);
});

check('the base stylesheet keeps the light design tokens', () => {
  assert.match(base, /--brand:\s*#0f766e/i, 'teal brand token missing from style.css');
});

/* ------------------------------------------------------- light is the default */

check('theme.js defaults to light', () => {
  assert.match(themeJs, /DEFAULT_THEME\s*=\s*'light'/, 'DEFAULT_THEME is not light');
  assert.match(
    themeJs,
    /apply\(\s*saved\s*===\s*'dark'\s*\?\s*'dark'\s*:\s*DEFAULT_THEME\s*,\s*false\s*\)/,
    'setInitialTheme no longer falls back to the light default'
  );
});

check('theme.js does not follow the OS colour scheme', () => {
  // A dark-mode OS must not flip REVEX to dark on first visit; dark is opt-in.
  const code = themeJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/matchMedia/.test(code), 'theme.js still queries matchMedia / prefers-color-scheme');
});

check('no page consults the OS colour scheme', () => {
  const root = path.join(__dirname, '..');
  const bad = [];
  for (const page of fs.readdirSync(root).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    if (/prefers-color-scheme|matchMedia/.test(html)) bad.push(`${page}: follows the OS colour scheme`);
  }
  assert.deepEqual(bad, []);
});

check('every page boots in light and only honours an explicit dark choice', () => {
  const root = path.join(__dirname, '..');
  const bad = [];
  for (const page of fs.readdirSync(root).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    if (!/<html[^>]*data-theme="light"/.test(html)) bad.push(`${page}: <html> does not declare data-theme="light"`);
    // The no-flash snippet must resolve an absent/stale value to light.
    const snippet = html.match(/localStorage\.getItem\('revexTheme'\)[\s\S]{0,200}?<\/script>/);
    if (!snippet) { bad.push(`${page}: no light-default no-flash snippet`); continue; }
    if (!/===\s*'dark'\s*\?\s*'dark'\s*:\s*'light'/.test(snippet[0])) {
      bad.push(`${page}: snippet does not default to light`);
    }
  }
  assert.deepEqual(bad, []);
});

console.log(`\n${'-'.repeat(58)}`);
console.log(`PASSED: ${pass}  FAILED: ${failures.length}`);
if (failures.length) { for (const f of failures) console.log(`  - ${f.label}: ${f.message}`); process.exit(1); }
console.log('All theme layer checks passed.');

#!/usr/bin/env node
/**
 * SYNC THE CONSOLIDATED UI LAYER  (scripts/sync-ui-layer.js)
 *
 * Every REVEX page must load, in this exact order:
 *
 *   1. the four base stylesheets
 *   2. css/theme.css          (light/dark tokens)
 *   3. css/revex-ui.css       (the consolidated component layer)   <- LAST css
 *   4. css/chat.css           (assistant only)                    <- LAST css
 *
 * and, for the scripts:
 *
 *   js/theme.js  ->  js/confirm-delete.js  ->  js/main.js  ->  js/payment.js
 *   ->  js/chat.js  ->  the page's own script
 *
 * `js/main.js` must load before any page script because it creates
 * `window.REVEX`, and `revex-ui.css` must be last so it composes the base rules
 * instead of being overridden by them. When the six stylesheets from the design
 * reference were loaded in a different order the same button rendered
 * differently on two pages, which is the class of bug this script prevents.
 *
 * Usage:  node scripts/sync-ui-layer.js            (rewrite every page)
 *         node scripts/sync-ui-layer.js --check    (fail if any page is wrong)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

/** Base stylesheets, in the order they must appear. */
const BASE_CSS = ['css/style.css', 'css/navbar.css', 'css/cards.css', 'css/responsive.css', 'css/theme.css'];
/** The consolidated layer, always last. */
const UI_CSS = ['css/revex-ui.css', 'css/chat.css'];
/** Scripts that must load before the page's own script. */
const BASE_JS = ['js/theme.js', 'js/confirm-delete.js', 'js/main.js', 'js/payment.js', 'js/chat.js'];

const RELATIVE_CSS = [...BASE_CSS, ...UI_CSS].map(href => `<link rel="stylesheet" href="${href}">`).join('');
const RELATIVE_JS = BASE_JS.map(src => `<script src="${src}"></script>`).join('\n  ');

const pages = fs.readdirSync(ROOT).filter(name => name.endsWith('.html') && !name.startsWith('.')).sort();
const problems = [];
let changed = 0;

/**
 * Rebuilds the stylesheet run: every known REVEX stylesheet is removed and the
 * canonical order is written back in one place. Idempotent.
 *
 * The match deliberately only spans HORIZONTAL whitespace. Consuming the
 * newline after the block would fight with scripts/sync-page-meta.js over the
 * indentation of the `<meta name="description">` line that follows it, and the
 * two scripts would rewrite each other's output on every run.
 */
function syncCss(html) {
  const known = [...BASE_CSS, ...UI_CSS];
  const block = /[ \t]*<link rel="stylesheet"[^>]*>(?:[ \t]*<link rel="stylesheet"[^>]*>)*[ \t]*/;
  // Keep any stylesheet that is not one of ours (e.g. a vendor sheet).
  const foreign = [...html.matchAll(/<link rel="stylesheet"[^>]*>/g)]
    .map(match => match[0])
    .filter(tag => !known.some(href => tag.includes(`href="${href}"`)));
  const tags = [...foreign, ...known.map(href => `<link rel="stylesheet" href="${href}">`)];
  const existing = block.exec(html);
  if (!existing) return html.replace('</head>', `  ${tags.join('')}\n</head>`);
  // No trailing newline: the newline that follows the block is OUTSIDE the
  // match (the pattern only spans horizontal whitespace), so adding one here
  // would insert a blank line on every run.
  return html.replace(existing[0], `  ${tags.join('')}`);
}

/**
 * Rebuilds the base script run: any copy of a base script is removed and the
 * canonical run is written immediately before the page's own script. Idempotent.
 */
function syncJs(html) {
  const base = new Set(BASE_JS);
  const own = [...html.matchAll(/[ \t]*<script src="([^"]+)"><\/script>\n?/g)]
    .filter(match => !base.has(match[1]));
  // Strip every base script currently on the page, keeping the page's own.
  let next = html.replace(/[ \t]*<script src="(?:js\/)?(?:theme|confirm-delete|main|payment|chat)\.js"><\/script>\n?/g, '');
  if (!own.length) return next.replace('</body>', `  ${RELATIVE_JS}\n</body>`);
  const anchor = `<script src="${own[own.length - 1][1]}"></script>`;
  return next.replace(anchor, `${RELATIVE_JS}\n  ${anchor}`);
}

for (const page of pages) {
  const file = path.join(ROOT, page);
  const original = fs.readFileSync(file, 'utf8');
  let next = syncJs(syncCss(original));

  if (next === original) continue;
  if (CHECK_ONLY) {
    problems.push(`${page}: the stylesheet or script order is out of date`);
  } else {
    fs.writeFileSync(file, next);
    changed += 1;
    console.log(`updated ${page}`);
  }
}

if (CHECK_ONLY) {
  if (problems.length) {
    console.error('UI layer is not in sync:');
    problems.forEach(problem => console.error(`  - ${problem}`));
    console.error('\nRun:  node scripts/sync-ui-layer.js');
    process.exit(1);
  }
  console.log(`UI layer is in sync across ${pages.length} page(s).`);
} else {
  console.log(changed ? `Updated ${changed} of ${pages.length} page(s).` : `All ${pages.length} page(s) already in sync.`);
}

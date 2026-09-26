/**
 * Adds the V5 typography loading block (preconnect + Manrope / Plus Jakarta
 * Sans) to every page, in the correct order relative to the stylesheets.
 *
 * The adopted stylesheets no longer use an @import for fonts, so the pages
 * must load them. This is idempotent: safe to re-run.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FONT_BLOCK = [
  '  <link rel="preconnect" href="https://fonts.googleapis.com">',
  '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;700;800&amp;family=Plus+Jakarta+Sans:wght@400;500;600;700;800&amp;display=swap" rel="stylesheet">'
].join('\n');

let changed = 0;
for (const file of fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))) {
  const full = path.join(ROOT, file);
  let html = fs.readFileSync(full, 'utf8');
  const before = html;

  if (!html.includes('fonts.googleapis.com')) {
    // Insert immediately before the first stylesheet link so the fonts are
    // requested as early as possible.
    html = html.replace(/([ \t]*)<link rel="stylesheet" href="css\/style\.css">/, `${FONT_BLOCK}\n$1<link rel="stylesheet" href="css/style.css">`);
  }

  if (html !== before) {
    fs.writeFileSync(full, html, 'utf8');
    changed++;
    console.log(`  updated ${file}`);
  }
}
console.log(`\n${changed} page(s) updated with the V5 font block.`);

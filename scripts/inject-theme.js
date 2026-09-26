// Injects the theme layer into any page that does not already reference it.
// Idempotent: safe to re-run.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));

const HEAD_SNIPPET = `<script>(function(){try{var k='revexTheme',s=localStorage.getItem(k);if(!s){s=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',s);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();</script>`;
const THEME_CSS = `  <link rel="stylesheet" href="css/theme.css">`;
const THEME_JS = `<script src="js/theme.js"></script>`;

let changed = 0;
for (const file of files) {
  const full = path.join(ROOT, file);
  let html = fs.readFileSync(full, 'utf8');
  const before = html;

  // 1. data-theme on <html>
  html = html.replace(/<html lang="en">/i, '<html lang="en" data-theme="light">');

  // 2. FOUC-prevention snippet right after the viewport meta
  if (!html.includes('revexTheme')) {
    html = html.replace(/(<meta name="viewport"[^>]*>)/i, `$1\n  ${HEAD_SNIPPET}`);
  }

  // 3. theme.css after the last stylesheet link
  if (!html.includes('css/theme.css')) {
    const links = [...html.matchAll(/[ \t]*<link rel="stylesheet" href="css\/responsive\.css">\s*/g)];
    if (links.length) {
      const last = links[links.length - 1];
      html = html.slice(0, last.index + last[0].length) + THEME_CSS + '\n' + html.slice(last.index + last[0].length);
    }
  }

  // 4. theme.js before main.js so the toggle is available to page scripts
  if (!html.includes('js/theme.js')) {
    html = html.replace(/([ \t]*)<script src="js\/main\.js"><\/script>/, `$1${THEME_JS}\n$1<script src="js/main.js"></script>`);
  }

  if (html !== before) {
    fs.writeFileSync(full, html, 'utf8');
    changed++;
    console.log(`  updated ${file}`);
  }
}
console.log(`\n${changed} page(s) updated.`);

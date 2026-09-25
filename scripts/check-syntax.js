// Syntax-checks every JavaScript source file in the project (excluding
// node_modules) so no file can silently ship with a parse error.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'uploads', '.vercel']);

function collect(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, found);
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

const files = collect(ROOT);
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push({ file: path.relative(ROOT, file), message: String(error.stderr || error.message).trim() });
  }
}

if (failures.length) {
  console.error(`\nSyntax check FAILED for ${failures.length} file(s):\n`);
  for (const failure of failures) console.error(`  ${failure.file}\n    ${failure.message.split('\n').slice(0, 3).join('\n    ')}\n`);
  process.exit(1);
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);

#!/usr/bin/env node
/**
 * SECURITY POSTURE  (tests/security.test.js)
 *
 * Static checks that the shipped project cannot leak a secret, cannot be talked
 * into reporting a success it did not achieve, and does not ship anything it
 * should not.
 *
 * These are pattern checks over the source, not a substitute for a real
 * penetration test - but every one of them corresponds to something that
 * actually went wrong in this project at some point.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./harness');

const ROOT = path.join(__dirname, '..');
const t = createSuite('security posture');

const SKIP = new Set(['node_modules', '.git', 'uploads', '.vercel', 'backups']);

function sources(dir = ROOT, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, found);
    else if (/\.(js|html|css|json|md|example|txt|bat|yaml|yml)$/.test(entry.name)) found.push(full);
  }
  return found;
}
const ALL = sources();
const read = file => fs.readFileSync(file, 'utf8');
const relative = file => path.relative(ROOT, file).replace(/\\/g, '/');

/** Shapes of a real credential. None of these may appear in the project. */
const FORBIDDEN = [
  { pattern: /mongodb\+srv:\/\/[^:<\s][^:]*:[^@<\s]{6,}@/g, name: 'a MongoDB connection string with a password' },
  { pattern: /rzp_live_[A-Za-z0-9]{10,}/g, name: 'a Razorpay live key' },
  { pattern: /AIza[0-9A-Za-z_-]{30,}/g, name: 'a Google API key' },
  { pattern: /sk-[A-Za-z0-9]{32,}/g, name: 'an OpenAI-style secret key' }
];

t.describe('no real secrets are committed', () => {
  // A real Atlas SRV string with a password, or a Razorpay secret, must never
  // be in the repository. Placeholders in .env.example are fine.
  const forbidden = [
    { pattern: /mongodb\+srv:\/\/[^:<\s][^:]*:[^@<\s]{6,}@/g, name: 'a MongoDB connection string with a password' },
    { pattern: /rzp_live_[A-Za-z0-9]{10,}/g, name: 'a Razorpay live key' },
    { pattern: /AIza[0-9A-Za-z_-]{30,}/g, name: 'a Google API key' },
    { pattern: /sk-[A-Za-z0-9]{32,}/g, name: 'an OpenAI-style secret key' }
  ];
  for (const file of ALL) {
    const text = read(file);
    // .env.example documents the SHAPE of a value; that is intentional.
    if (relative(file).endsWith('.env.example')) continue;
    for (const { pattern, name } of FORBIDDEN) {
      pattern.lastIndex = 0;
      const found = text.match(pattern);
      t.equal(found ? found.length : 0, 0, `${relative(file)} contains no ${name}`);
    }
  }
});

t.describe('.env files are never part of the deliverable', () => {
  // A real `.env` in the working tree is NORMAL during development - it is
  // where the developer's Atlas URI, JWT secret and Razorpay keys live. What
  // must hold is that it is ignored by git and refused by the packer.
  t.match(read('.gitignore'), /^\.env$/m, '.gitignore excludes .env');
  t.match(read('.gitignore'), /^backend\/\.env$/m, '.gitignore excludes backend/.env');
  const pack = read('scripts/pack.js');
  t.match(pack, /EXCLUDED_FILES = new Set\(\[[\s\S]*?'\.env'/, 'the packer excludes .env by name');
  t.match(pack, /EXCLUDED_DIRS = new Set\(\[[\s\S]*?'node_modules'/, 'the packer excludes node_modules');
  t.match(pack, /Refusing to pack/, 'the packer refuses to build if a secret is still on the list');
  t.match(pack, /isRealEnv[\s\S]{0,120}example\|sample\|template/, 'the packer allows .env.example, which is a template and must ship');
  t.match(pack, /isRealEnv\(file\) && !\(INCLUDE_ENV && file === 'backend\/\.env'\)/,
    'the final guard re-checks for a real .env, and only tolerates the ONE path --include-env allows');
  t.match(pack, /file\.includes\('node_modules'\)/, 'the final guard also re-checks for node_modules');
  // Shipping the real .env has to be a deliberate, visible, per-invocation act.
  t.match(pack, /const INCLUDE_ENV = process\.argv\.includes\('--include-env'\)/,
    'the .env is only ever included when --include-env is typed explicitly');
  t.match(pack, /--include-env must be used with a \.zip output path/,
    'and it refuses a non-zip output, so it cannot be attached to something unexpected');
  t.match(pack, /DO NOT email it, upload it/, 'the packer prints a loud warning naming the risk');
  t.match(pack, /if \(INCLUDE_ENV && rel === 'backend\/\.env'\) return false/,
    'only backend/.env is let through; an .env.local still stops the build');
  t.match(pack, /if \(!files\.includes\('backend\/\.env'\)\)/,
    'and the build fails loudly if --include-env was passed but there is no .env to include');
  // OneDrive on this machine deletes a new file from the Desktop within seconds,
  // so the archive defaults to a local folder instead.
  t.match(pack, /Downloads/, 'the packer writes to a local Downloads folder by default');
  // Compress-Archive writes backslash entry names, which flatten the project on
  // macOS and Linux, so the archive is written by hand.
  t.match(pack, /writeArchive\(OUTPUT, files\.map/, 'the packer writes the archive itself with spec-compliant names');
  t.match(pack, /central directory signature/, 'the packer writes a central directory');
  t.match(pack, /end of central directory/, 'the packer writes an end-of-central-directory record');
  t.match(pack, /Compress-Archive/, 'the packer explains why Compress-Archive is not used');
  t.match(pack, /\$\{FOLDER\}\/\$\{file\.split\(path\.sep\)\.join\('\/'\)\}/,
    'every entry name is prefixed with the folder and uses forward slashes');
  t.equal(fs.existsSync(path.join(ROOT, 'package-lock.json')), true, 'a lockfile ships so installs are reproducible');
});

t.describe('passwords never have defaults in source', () => {
  for (const file of ALL) {
    const relativePath = relative(file);
    if (relativePath.endsWith('.env.example')) continue;
    if (relativePath.startsWith('tests/')) continue;
    const text = read(file);
    // A literal password next to a bcrypt.hash() or a comparison is a
    // backdoor. ADMIN_PASSWORD must come from the environment.
    t.notMatch(text, /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"$\n]{4,}['"]\s*,?\s*\n?\s*(?:await\s+)?bcrypt/i,
      `${relativePath} has no hard-coded password next to a hash`);
    t.notMatch(text, /password\s*===\s*['"][^'"]+['"]/, `${relativePath} has no hard-coded password comparison`);
  }
  t.match(read('backend/server.js'), /process\.env\.ADMIN_PASSWORD/, 'the admin password comes from the environment');
  t.match(read('backend/server.js'), /JWT_SECRET is missing/, 'the server refuses to start without a JWT secret');
});

t.describe('the JWT secret is required and never defaulted', () => {
  const server = read('backend/server.js');
  const api = read('api/index.js');
  // `|| ''` (an empty default) is fine; a non-empty literal default is not.
  t.notMatch(server, /JWT_SECRET\s*\|\|\s*['"][^'"]+['"]/, 'server.js has no non-empty fallback JWT secret');
  t.notMatch(api, /JWT_SECRET\s*\|\|\s*['"][^'"]+['"]/, 'api/index.js has no non-empty fallback JWT secret');
  t.notMatch(read('backend/middleware/auth.js'), /JWT_SECRET\s*\|\|\s*['"][^'"]+['"]/, 'auth middleware has no non-empty fallback JWT secret');
  t.match(server, /if \(!process\.env\.JWT_SECRET\) throw/, 'server.js throws when the secret is missing');
  t.match(api, /if \(!process\.env\.JWT_SECRET\)/, 'api/index.js returns 500 when the secret is missing');
  t.match(read('backend/middleware/auth.js'), /jwt\.verify/, 'tokens are verified, not decoded');
});

t.describe('secrets never reach the browser', () => {
  const configRoute = read('backend/routes/payments.js');
  t.notMatch(configRoute, /RAZORPAY_KEY_SECRET:\s*process\.env/, 'the payment config route does not return the secret');
  t.match(read('backend/utils/payments.js'), /keyId: isConfigured\(\) \? process\.env\.RAZORPAY_KEY_ID : ''/, 'only the publishable key id is returned');
  const chat = read('backend/routes/chat.js');
  // Provider resolution and the status payload live in utils/chatProvider.js.
  const provider = read('backend/utils/chatProvider.js');
  t.notMatch(chat, /apiKey:\s*config\.apiKey/, 'the chat route does not echo the API key');
  t.notMatch(chat, /res\.json\([\s\S]{0,200}apiKey/, 'no chat response body contains the key');
  t.notMatch(provider, /res\.json\([\s\S]{0,200}apiKey/, 'the provider module returns no key either');
  t.match(provider, /endpoint: config\.configured \? config\.url\.replace/, 'the chat status endpoint masks the key in the URL');
  t.match(provider, /\$1\*\*\*/, 'and the mask is a placeholder, not a truncation');
  t.match(provider, /isTransportSafe/, 'the key is never sent over plain http to a remote host');
  t.match(read('backend/utils/payments.js'), /never leaves the server|publicConfig/, 'the gateway module documents what is public');
  // The frontend must never read a secret from the environment.
  for (const file of fs.readdirSync(path.join(ROOT, 'js'))) {
    t.notMatch(read(path.join('js', file)), /KEY_SECRET|RAZORPAY_KEY_SECRET|JWT_SECRET/, `js/${file} contains no secret name`);
  }
});

t.describe('config diagnostics never print a secret', () => {
  const server = read('backend/server.js');
  const report = server.slice(server.indexOf('function reportConfig'), server.indexOf('async function start'));
  t.match(report, /MONGODB_URI\s*=\s*\$\{process\.env\.MONGODB_URI \? 'configured' : 'MISSING'\}/, 'MONGODB_URI is reported as present or missing only');
  t.notMatch(report, /\$\{process\.env\.JWT_SECRET\}/, 'the JWT secret value is never interpolated into the log');
  t.match(report, /configured \(\$\{secret\.length\} chars\)/, 'the secret is reported by length only');
});

t.describe('user input is escaped before it reaches innerHTML', () => {
  t.match(read('js/main.js'), /function escapeHtml/, 'the escaping helper exists and is the single one used');
  t.match(read('js/main.js'), /replace\(\/\[&<>\"'\]/, 'escapeHtml covers the five dangerous characters');
  t.match(read('js/chat.js'), /textContent = String\(text/, 'the assistant renders its output as text, never as HTML');

  // A general "did you escape it?" heuristic produces false positives on nested
  // template literals, so the high-risk values are asserted at their single
  // render site instead. Each entry names the value and the risk.
  const SITES = [
    ['js/rides.js', 'ride.from', /escapeHtml\(ride\.from\)/, 'the ride origin is escaped on the card'],
    ['js/rides.js', 'ride.to', /escapeHtml\(ride\.to\)/, 'the ride destination is escaped on the card'],
    ['js/rides.js', 'currentRide.from', /escapeHtml\(item\.from\)/, 'the ride origin is escaped on the ride detail panel'],
    ['js/rides.js', 'currentRide.to', /escapeHtml\(item\.to\)/, 'the ride destination is escaped on the ride detail panel'],
    ['js/admin.js', 'ride.from', /escapeHtml\(ride\.from\)/, 'the ride origin is escaped in the approval queue'],
    ['js/admin.js', 'ride.driverName', /escapeHtml\(ride\.driverName/, 'the driver name is escaped in the approval queue'],
    ['js/admin.js', 'vehicle.numberPlate', /escapeHtml\(vehicle\.numberPlate/, 'the number plate is escaped in the owner summary'],
    ['js/admin.js', 'vehicle.owner', /escapeHtml\(vehicle\.owner\?\.name/, 'the owner name is escaped in the owner summary'],
    ['js/admin.js', 'row.reason', /escapeHtml\(ride\.cancellationInfo\.lastReason\)/, 'a cancellation reason is escaped in the owner summary'],
    ['js/ride-requests.js', 'row.userName', /escapeHtml\(row\.userName/, 'the rider name is escaped on the request card'],
    ['js/booking.js', 'item.cancellation', /escapeHtml\(item\.cancellation\.cancellationBy/, 'a cancellation reason is escaped in My Bookings'],
    ['js/owner.js', 'item.userId', /escapeHtml\(item\.userId\?\.name/, 'the renter name is escaped in the owner request list'],
    ['js/profile-page.js', 'item.message', /escapeHtml\(item\.message\)/, 'a notification message is escaped'],
    ['js/admin.js', 'rental booking cancellation', /escapeHtml\(booking\.cancellation\.reason\)/, 'a cancellation reason is escaped in the rental booking list'],
    ['js/ride-requests.js', 'row.cancellation', /escapeHtml\(row\.cancellation\.reason\)/, 'a cancellation reason is escaped on the ride request card']
  ];
  for (const [file, what, pattern, description] of SITES) {
    t.match(read(file), pattern, `${file}: ${description}`);
  }

  // Every file that writes HTML must have the helper available to it.
  for (const file of fs.readdirSync(path.join(ROOT, 'js'))) {
    const text = read(path.join('js', file));
    const writesHtml = /innerHTML\s*=|insertAdjacentHTML|outerHTML/.test(text);
    if (!writesHtml) continue;
    t.match(text, /escapeHtml|imageOrInitials|statusBadge/, `js/${file} has an escaping helper available where it writes HTML`);
  }
});

t.describe('uploads are validated by type and size', () => {
  t.match(read('backend/routes/vehicles.js'), /data:image\\\/\(png\|jpeg\|jpg\|webp\|gif\)/, 'vehicle uploads accept a fixed list of raster types and never SVG');
  const owner = read('js/owner.js');
  t.match(owner, /UPLOAD_LIMITS = \{/, 'the owner portal has explicit upload budgets');
  t.match(owner, /assertUploadBudget/, 'the combined upload size is checked before the request is sent');
  t.match(read('backend/routes/auth.js'), /svg/i, 'profile photo validation rejects SVG');
  t.match(read('backend/server.js'), /entity\.too\.large/, 'an oversized body produces a clear 413');
});

t.describe('CORS is not wide open by default', () => {
  const security = read('backend/utils/security.js');
  t.notMatch(security, /origin:\s*['"]\*['"]\s*,?\s*$/m, 'there is no unconditional wildcard origin');
  t.match(security, /FRONTEND_URL|CORS_ALLOWED_ORIGINS/, 'allowed origins are configuration, not a constant');
  t.match(read('backend/utils/security.js'), /Vary/, 'the CORS response varies by origin so caches cannot serve the wrong one');
});

t.describe('demo accounts cannot be seeded with a published password', () => {
  const reset = read('scripts/reset-db.js');
  t.match(reset, /DEMO_ADMIN_PASSWORD/, 'the demo admin password is overridable from the environment');
  t.match(reset, /function looksRemote\(uri\)/, 'the script can tell a remote database from a local one');
  t.match(reset, /REFUSING TO RUN/, 'it refuses to write the published defaults into a remote database');
  t.match(reset, /usingDefaults && looksRemote\(uri\)/, 'the refusal is gated on both the defaults and the target');
  t.match(reset, /WARNING: seeding local demo accounts/, 'a local seed still warns the developer');
});

t.describe('the .env.example files document names only', () => {
  for (const file of ['.env.example', 'backend/.env.example']) {
    const text = read(file);
    t.ok(!text.includes('mongodb+srv://'), `${file} contains no connection string`);
    t.match(text, /CHAT_API_KEY=/, `${file} documents CHAT_API_KEY`);
    t.match(text, /RAZORPAY_KEY_SECRET=/, `${file} documents RAZORPAY_KEY_SECRET`);
    t.match(text, /CANCEL_FREE_WINDOW_HOURS=/, `${file} documents the cancellation policy`);
    for (const { pattern } of FORBIDDEN) {
      pattern.lastIndex = 0;
      t.equal((text.match(pattern) || []).length, 0, `${file} contains no live credential`);
    }
  }
});

t.describe('the deliverable is not bloated', () => {
  t.equal(fs.existsSync(path.join(ROOT, 'node_modules')) && fs.existsSync(path.join(ROOT, 'package-lock.json')), true,
    'a lockfile is present so installs are reproducible');
  t.match(read('package.json'), /"node": ">=18/, 'the minimum Node version is declared');
  // multer was declared but never used: every upload is a validated data URL.
  t.notMatch(read('package.json'), /"multer"/, 'the unused multer dependency is not declared');
  const used = new Set();
  for (const dir of ['backend', 'js', 'scripts', 'api', 'tests']) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of sources(full)) used.add(read(entry));
  }
  t.notMatch([...used].join('\n'), /require\('multer'\)/, 'nothing requires multer');
});

t.done();

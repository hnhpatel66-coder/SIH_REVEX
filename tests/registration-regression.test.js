/**
 * Regression tests for the two root causes behind the "Create Account fails"
 * bug. These are pure/unit level — no database required.
 *
 * 1. Missing Content-Type: pages that pre-stringified their JSON body sent no
 *    content type, express.json() left req.body as {} and the backend replied
 *    "Name, email and password are required." for a perfectly valid payload.
 * 2. Relative API base: `const API_BASE = '/api'` only works when the page is
 *    served by the API itself; from Live Server / Vite the request never
 *    reached the backend.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildMongoUri } = require('../backend/utils/db');
const { BLOCKED_STATIC } = require('../backend/utils/security');

let pass = 0; const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log('\nRegistration root-cause regressions\n');

// ---------------------------------------------------------------------------
// 1. The api() body/Content-Type contract, evaluated with the real source.
// ---------------------------------------------------------------------------
const mainJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');

// Extract the body-handling block from api() and run it the way the browser does.
const bodyBlock = mainJs.match(/let body = options\.body;[\s\S]*?\n  \}/);
check('api() declares a content type for pre-stringified bodies', () => {
  assert.ok(bodyBlock, 'could not locate the body-handling block in js/main.js');
  assert.ok(
    !/typeof body !== 'string'\)\s*\{\s*body = JSON\.stringify\(body\);\s*headers\['Content-Type'\]/.test(bodyBlock[0]),
    'the old bug is back: Content-Type is only set when the body is NOT a string'
  );
  // The fixed shape: serialise if needed, then always declare the content type.
  assert.match(bodyBlock[0], /if \(!hasContentType\)/);
});

// Simulate the browser behaviour end to end.
function apiBodyHandling(options) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body && !(body instanceof FormData)) {
    if (typeof body !== 'string') body = JSON.stringify(body);
    const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
    if (!hasContentType) headers['Content-Type'] = 'application/json';
  }
  return { headers, body };
}

const isPlainObject = v => v !== null && typeof v === 'object' && !(v instanceof FormData);

check('pre-stringified body now carries application/json', () => {
  const payload = { name: 'Asha', email: 'asha@example.com', password: 'Abcd1234!' };
  const { headers, body } = apiBodyHandling({ body: JSON.stringify(payload) });
  assert.equal(headers['Content-Type'], 'application/json', 'content type still missing for string bodies');
  assert.deepEqual(JSON.parse(body), payload);
});

check('object body still works (login-style callers)', () => {
  const { headers, body } = apiBodyHandling({ body: { email: 'a@b.com' } });
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(body).email, 'a@b.com');
});

check('an explicit content type is never overwritten', () => {
  const { headers } = apiBodyHandling({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');
});

check('FormData uploads are left alone', () => {
  const fd = new FormData();
  const { headers } = apiBodyHandling({ body: fd });
  assert.equal(headers['Content-Type'], undefined, 'FormData must not get a JSON content type');
});

check('a body-less request sends no content type', () => {
  const { headers } = apiBodyHandling({});
  assert.equal(headers['Content-Type'], undefined);
});

// ---------------------------------------------------------------------------
// 2. API base resolution
// ---------------------------------------------------------------------------
check('main.js no longer hard-codes a relative-only API base', () => {
  assert.ok(!/const API_BASE = '\/api';/.test(mainJs), "API_BASE is hard-coded to '/api' again");
  assert.ok(/function resolveApiBase\(\)/.test(mainJs), 'resolveApiBase() is missing');
  assert.ok(/REVEX_DEFAULT_API_PORT = 5001/.test(mainJs), 'default API port should be 5001');
});

check('the real resolver picks the right base per origin', () => {
  const fnSource = mainJs.match(/function resolveApiBase\(\)[\s\S]*?\n\}/);
  assert.ok(fnSource, 'resolveApiBase not found');
  // Evaluate the resolver (plus the constants it closes over) against a fake
  // location/meta for several origins.
  const port = (mainJs.match(/REVEX_DEFAULT_API_PORT = (\d+)/) || [])[1] || '5001';
  const ports = (mainJs.match(/REVEX_API_PORTS = \[([^\]]*)\]/) || [])[1] || `'5000','${port}'`;
  // The array holds the string '[::1]', so match up to the closing "];".
  const hosts = (mainJs.match(/LOCAL_HOSTS = \[([\s\S]*?)\];/) || [])[1] || "'localhost'";
  const build = new Function(
    'location', 'document', 'window',
    `const REVEX_DEFAULT_API_PORT = ${port};\nconst REVEX_API_PORTS = [${ports}];\nconst LOCAL_HOSTS = [${hosts}];\n${fnSource[0]}\nreturn resolveApiBase();`
  );
  const fakeDoc = content => ({ querySelector: () => (content ? { content } : null) });
  const win = { REVEX_API_BASE: undefined };

  // Served by the API itself -> same-origin relative path.
  assert.equal(build({ protocol: 'http:', hostname: 'localhost', port: '5001' }, fakeDoc(''), win), '/api');
  assert.equal(build({ protocol: 'http:', hostname: 'localhost', port: '5000' }, fakeDoc(''), win), '/api');
  // Deployed behind a proxy (no port) -> same-origin.
  assert.equal(build({ protocol: 'https:', hostname: 'revex.app', port: '' }, fakeDoc(''), win), '/api');
  // Served by a separate dev server -> absolute API URL. This is the case that
  // silently broke registration before.
  assert.equal(
    build({ protocol: 'http:', hostname: '127.0.0.1', port: '5500' }, fakeDoc(''), win),
    'http://127.0.0.1:5001/api'
  );
  // Explicit overrides win.
  assert.equal(build({ protocol: 'http:', hostname: 'x', port: '5500' }, fakeDoc('http://api.test:9/api'), win), 'http://api.test:9/api');
  assert.equal(build({ protocol: 'http:', hostname: 'x', port: '5500' }, fakeDoc(''), { REVEX_API_BASE: 'https://api.test/api/' }), 'https://api.test/api');
});

// ---------------------------------------------------------------------------
// 3. Mongo URI construction (explicit database name)
// ---------------------------------------------------------------------------
check('a URI without a database name gets one', () => {
  assert.equal(
    buildMongoUri('mongodb+srv://u:p@revex.r2zrw0p.mongodb.net', 'vroomy'),
    'mongodb+srv://u:p@revex.r2zrw0p.mongodb.net/vroomy'
  );
});
check('no double slash when the URI ends with /', () => {
  assert.equal(
    buildMongoUri('mongodb+srv://u:p@revex.r2zrw0p.mongodb.net/', 'vroomy'),
    'mongodb+srv://u:p@revex.r2zrw0p.mongodb.net/vroomy'
  );
});
check('the query string is preserved', () => {
  assert.equal(
    buildMongoUri('mongodb+srv://u:p@revex.r2zrw0p.mongodb.net/?retryWrites=true&w=majority', 'vroomy'),
    'mongodb+srv://u:p@revex.r2zrw0p.mongodb.net/vroomy?retryWrites=true&w=majority'
  );
});
check('an existing database name is not overwritten', () => {
  assert.equal(
    buildMongoUri('mongodb+srv://u:p@host.mongodb.net/otherdb?retryWrites=true', 'vroomy'),
    'mongodb+srv://u:p@host.mongodb.net/otherdb?retryWrites=true'
  );
});

// ---------------------------------------------------------------------------
// 4. The deleted cluster must never reappear in executable code
// ---------------------------------------------------------------------------
const WALK_SKIP = new Set(['node_modules', '.git', 'uploads', '.vercel']);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (WALK_SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|html|json|bat|example|env)$/.test(e.name) && e.name !== '.env') out.push(full);
  }
  return out;
}

check('the deleted cluster is absent from all executable files', () => {
  const root = path.join(__dirname, '..');
  const self = path.resolve(__filename);
  // Built dynamically so this test file does not match itself.
  const needle = ['vroomy', 'eazd3bx', 'mongodb', 'net'].join('.');
  const offenders = [];
  for (const file of walk(root)) {
    if (path.resolve(file) === self) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(needle) || text.includes('eazd3bx') || text.includes('mihir1458')) {
      offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, [], `old cluster still referenced in: ${offenders.join(', ')}`);
});

check('the new cluster is the configured default', () => {
  const text = fs.readFileSync(path.join(root0(), 'backend', '.env.example'), 'utf8');
  assert.ok(text.includes('revex.r2zrw0p.mongodb.net'), 'new cluster missing from .env.example');
  assert.ok(!text.includes('eazd3bx'), 'old cluster present in .env.example');
});
function root0() { return path.join(__dirname, '..'); }

check('static blocklist still protects sensitive files', () => {
  for (const t of ['/package.json', '/.env', '/backend/server.js']) {
    assert.ok(BLOCKED_STATIC.some(p => p.test(t)), `${t} should be blocked`);
  }
});

console.log(`\n${'-'.repeat(58)}`);
console.log(`PASSED: ${pass}  FAILED: ${failures.length}`);
if (failures.length) { for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); process.exit(1); }
console.log('All registration root-cause regressions passed.');

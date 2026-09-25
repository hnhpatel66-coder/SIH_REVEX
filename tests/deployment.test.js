/**
 * Deployment-safety regressions.
 *
 * A hosted deployment (Render, Railway, Fly.io) is proxied on a port the app
 * does not control. The frontend must therefore always use a SAME-ORIGIN API
 * base there. An earlier version derived an absolute "http://<host>:5001/api"
 * URL from any unrecognised port, which silently broke every API call on a
 * production host.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
let pass = 0; const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log('\nDeployment safety\n');

// Build the real resolver out of the shipped source so the test tracks it.
const fnSource = mainJs.match(/function resolveApiBase\(\)[\s\S]*?\n\}/);
assert.ok(fnSource, 'resolveApiBase() not found in js/main.js');
const port = (mainJs.match(/REVEX_DEFAULT_API_PORT = (\d+)/) || [])[1] || '5001';
const ports = (mainJs.match(/REVEX_API_PORTS = \[([^\]]*)\]/) || [])[1] || `'5000','${port}'`;
// The array contains the string '[::1]', so match up to the closing "];"
// instead of the first "]".
const hosts = (mainJs.match(/LOCAL_HOSTS = \[([\s\S]*?)\];/) || [])[1] || "'localhost'";

const build = new Function(
  'location', 'document', 'window',
  `const REVEX_DEFAULT_API_PORT = ${port};
   const REVEX_API_PORTS = [${ports}];
   const LOCAL_HOSTS = [${hosts}];
   ${fnSource[0]}
   return resolveApiBase();`
);
const fakeDoc = content => ({ querySelector: () => (content ? { content } : null) });
const win = { REVEX_API_BASE: undefined };
const at = (protocol, hostname, locPort) => build({ protocol, hostname, port: locPort }, fakeDoc(''), win);

check('a Render-style https host on the default port is same-origin', () => {
  assert.equal(at('https:', 'revex-app.onrender.com', ''), '/api');
});

check('a production host behind a non-standard proxy port is same-origin', () => {
  // The regression: this used to resolve to http://host:5001/api.
  assert.equal(at('http:', 'revex-app.onrender.com', '10000'), '/api');
  assert.equal(at('https:', 'revex-app.onrender.com', '8080'), '/api');
  assert.equal(at('https:', 'myapp.vercel.app', '443'), '/api');
  assert.equal(at('http:', '203.0.113.10', '3000'), '/api');
});

check('a production host never points at the local dev port', () => {
  const resolved = at('http:', 'revex-app.onrender.com', '10000');
  assert.ok(!resolved.includes('5001'), `production resolved to ${resolved}`);
});

check('localhost on the API ports stays same-origin', () => {
  assert.equal(at('http:', 'localhost', '5001'), '/api');
  assert.equal(at('http:', 'localhost', '5000'), '/api');
  assert.equal(at('http:', 'localhost', ''), '/api');
});

check('a LOCAL dev server on another port still reaches the backend', () => {
  assert.equal(at('http:', 'localhost', '5500'), 'http://localhost:5001/api');
  assert.equal(at('http:', '127.0.0.1', '5173'), 'http://127.0.0.1:5001/api');
  assert.equal(at('http:', '0.0.0.0', '8080'), 'http://0.0.0.0:5001/api');
});

check('an explicit override always wins', () => {
  const overridden = build(
    { protocol: 'https:', hostname: 'anything.example', port: '9000' },
    fakeDoc('https://api.example.com/api'),
    win
  );
  assert.equal(overridden, 'https://api.example.com/api');
  const viaGlobal = build(
    { protocol: 'https:', hostname: 'anything.example', port: '9000' },
    fakeDoc(''),
    { REVEX_API_BASE: 'https://api.example.com/api/' }
  );
  assert.equal(viaGlobal, 'https://api.example.com/api', 'trailing slash should be trimmed');
});

check('the server honours an injected PORT before its default', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  const line = (server.match(/const PORT = .*/) || [])[0] || '';
  assert.ok(line.includes('process.env.PORT'), `PORT must read the environment: ${line}`);
  assert.ok(
    !/process\.env\.PORT\s*\|\|\s*5000/.test(line),
    'PORT must not default to 5000, which collides with the previous local port'
  );
});

check('CORS configuration allows the Render service origin automatically', () => {
  const security = fs.readFileSync(path.join(__dirname, '..', 'backend', 'utils', 'security.js'), 'utf8');
  assert.match(security, /RENDER_EXTERNAL_URL/);
  assert.match(security, /RENDER_EXTERNAL_HOSTNAME/);
  assert.match(security, /credentials:\s*true/);
});

check('the server serves the frontend itself (same-origin is possible)', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.match(server, /express\.static\(path\.join\(__dirname, '\.\.'\)\)/);
});

check('local secrets stay out of version control', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(ignore, /^\.env$/m, '.env must be ignored');
  assert.match(ignore, /^backend\/\.env$/m, 'backend/.env must be ignored');
  assert.match(ignore, /^node_modules\/$/m);
  assert.match(ignore, /^backups\/$/m, 'database backups must be ignored');
});

check('no committed file hard-codes a MongoDB credential', () => {
  const root = path.join(__dirname, '..');
  const skip = new Set(['node_modules', '.git', 'uploads', '.vercel', 'backups']);
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.(js|html|json|md|bat|example)$/.test(e.name) && e.name !== '.env') out.push(full);
    }
    return out;
  };
  // Placeholders are expected in docs, templates and this test's own patterns.
  const PLACEHOLDER = /(user|pass|password|username|secret|example|placeholder|cluster|host|db_|<|x)/i;
  const offenders = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file);
    if (rel.startsWith('tests') || /\.example$/.test(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/mongodb\+srv:\/\/([^:\s]+):([^@\s]+)@/g)) {
      if (!PLACEHOLDER.test(match[1]) || !PLACEHOLDER.test(match[2])) {
        offenders.push(`${rel} (user "${match[1]}")`);
      }
    }
  }
  assert.deepEqual(offenders, [], `literal MongoDB credentials found in: ${offenders.join(', ')}`);
});

console.log(`\n${'-'.repeat(58)}`);
console.log(`PASSED: ${pass}  FAILED: ${failures.length}`);
if (failures.length) { for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); process.exit(1); }
console.log('All deployment safety checks passed.');

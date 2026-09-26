#!/usr/bin/env node
/**
 * NO DUPLICATE ROUTES  (tests/no-duplicate-routes.test.js)
 *
 * Express silently accepts two handlers for the same method and path: the FIRST
 * one that sends a response wins and the rest are dead code that still reads as
 * if it works. REVEX had exactly that - an admin booking cancel route that
 * shadowed a status route, and a `POST /api/bookings/cancel` that duplicated a
 * PATCH endpoint. Nobody noticed for months because the code looked right.
 *
 * These checks parse the route files and fail on any collision, in either
 * direction, and additionally assert that a documented "removed duplicate" note
 * stays honest.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./harness');

const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(ROOT, 'backend', 'routes');
const t = createSuite('no duplicate routes');

const files = fs.readdirSync(ROUTES).filter(name => name.endsWith('.js'));

/**
 * Each router is mounted under a fixed prefix, so two routes only collide when
 * their PREFIXED paths match. Without this, `GET /summary` in admin.js would be
 * reported as clashing with `GET /:id` in bookings.js, which are different
 * endpoints on completely different mounts.
 *
 * The variable name in server.js does not always match the file name
 * (`bookingRoutes` mounts bookings.js), so the mapping is written out and then
 * VERIFIED against server.js - a renamed mount fails the test rather than
 * silently disabling the collision check.
 */
const EXPECTED_MOUNTS = {
  'auth.js': ['authRoutes', '/api/auth'],
  'vehicles.js': ['vehicleRoutes', '/api/vehicles'],
  'bookings.js': ['bookingRoutes', '/api/bookings'],
  'rides.js': ['rideRoutes', '/api/rides'],
  'admin.js': ['adminRoutes', '/api/admin'],
  'notifications.js': ['notificationRoutes', '/api/notifications'],
  'chat.js': ['chatRoutes', '/api/chat'],
  'payments.js': ['paymentRoutes', '/api/payments']
};

const PREFIXES = {};
for (const [file, [variable, prefix]] of Object.entries(EXPECTED_MOUNTS)) {
  PREFIXES[file] = prefix;
  const source = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');
  t.match(source, new RegExp(`app\\.use\\('${prefix}', ${variable}\\)`), `server.js mounts ${file} at ${prefix}`);
}

/**
 * Extracts `router.<method>('<path>'` declarations, skipping the ones inside a
 * comment (they are notes about routes that no longer exist).
 */
function routesIn(file) {
  const source = fs.readFileSync(path.join(ROUTES, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const found = [];
  const pattern = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\2/g;
  let match;
  while ((match = pattern.exec(source))) {
    found.push({
      method: match[1].toUpperCase(),
      path: `${PREFIXES[file] || ''}${match[3]}`.replace(/\/+$/, '') || '/',
      raw: match[3],
      file,
      line: source.slice(0, match.index).split('\n').length
    });
  }
  return found;
}

/**
 * A real duplicate is the same method and the same PREFIXED path, with
 * parameters in the same positions. A literal next to a parameter is NOT a
 * duplicate - `GET /my` and `GET /:id` are different endpoints that Express
 * disambiguates by declaration order, which the next check covers.
 */
function collides(a, b) {
  if (a.method !== b.method) return false;
  if (a.path === b.path) return true;
  const left = a.path.split('/').filter(Boolean);
  const right = b.path.split('/').filter(Boolean);
  if (left.length !== right.length) return false;
  // Two different parameter names in the same position are the same route.
  return left.every((segment, index) => segment === right[index]
    || (segment.startsWith(':') && right[index].startsWith(':')));
}

const all = [];
for (const file of files) {
  for (const route of routesIn(file)) all.push({ ...route, file });
}

t.describe('every route file parses', () => {
  t.ok(all.length > 40, `found ${all.length} route declarations to check`);
});

t.describe('no method+path is declared twice', () => {
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      t.equal(collides(a, b), false,
        `${a.file}:${a.line} ${a.method} ${a.path} does not collide with ${b.file}:${b.line} ${b.method} ${b.path}`);
    }
  }
});

t.describe('literal paths are declared before the parameters that would shadow them', () => {
  // Express matches in DECLARATION order, so `GET /my` placed after
  // `GET /:id` is unreachable: a request for /my is swallowed by /:id and
  // returns "booking not found". This is the same class of silent bug as a
  // duplicate route, and it is how /bookings/my and /rides/mine used to break.
  for (const file of files) {
    const routes = routesIn(file);
    for (const param of routes.filter(route => route.raw.split('/').some(segment => segment.startsWith(':')))) {
      for (const literal of routes.filter(route => !route.raw.split('/').some(segment => segment.startsWith(':')))) {
        if (literal.file !== param.file) continue;
        // Only the literal declared AFTER the parameter is at risk; one
        // declared before it wins the match, which is what we want.
        if (literal.line < param.line) continue;
        const a = param.raw.split('/').filter(Boolean);
        const b = literal.raw.split('/').filter(Boolean);
        if (a.length !== b.length) continue;
        const shadowed = a.every((segment, index) => segment.startsWith(':') ? true : segment === b[index]);
        if (shadowed && a.length === b.length && a.some((segment, index) => segment.startsWith(':') && segment !== b[index])) {
          t.equal(true, false,
            `${file}: ${param.method} ${param.raw} (line ${param.line}) is declared before the literal ${literal.method} ${literal.raw} (line ${literal.line}) and would swallow it`);
        }
      }
    }
  }
});

t.describe('the deliberate comment stays true', () => {
  const bookings = fs.readFileSync(path.join(ROUTES, 'bookings.js'), 'utf8');
  t.match(bookings, /Do not re-add a duplicate admin route here|admin booking listings live in routes\/admin\.js/,
    'bookings.js still points admins at the admin router instead of duplicating the route');
  const admin = fs.readFileSync(path.join(ROUTES, 'admin.js'), 'utf8');
  t.notMatch(admin.replace(/\/\*[\s\S]*?\*\//g, ''), /router\.(get|post|put|patch|delete)\(\s*['"`]\/bookings\/cancel['"`]/,
    'there is no leftover POST /api/admin/bookings/cancel');
});

t.describe('sensitive endpoints are protected', () => {
  const admin = fs.readFileSync(path.join(ROUTES, 'admin.js'), 'utf8');
  t.match(admin, /router\.use\(requireAuth, requireRole\('admin'\)\)/, 'the whole admin router requires an admin session');
  t.match(fs.readFileSync(path.join(ROUTES, 'payments.js'), 'utf8'), /requireAuth, requireRole\('admin'\)/, 'the admin payment ledger is admin-only');
  const chat = fs.readFileSync(path.join(ROUTES, 'chat.js'), 'utf8');
  t.match(chat, /, requireAuth[),]/, 'every chat route requires a session');
  t.notMatch(chat, /router\.(get|post|delete)\(\s*['"`]\/?['"`]\s*,\s*async/, 'there is no unauthenticated chat handler');
  t.match(fs.readFileSync(path.join(ROUTES, 'payments.js'), 'utf8'), /You cannot view this payment/, 'a payment receipt is scoped to its payer, owner or an admin');
  t.match(admin, /router\.use\(requireAuth, requireRole\('admin'\)\)/, 'admin routes are not reachable by an owner or a rider');
});

t.describe('the new routers are mounted', () => {
  const server = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'api', 'index.js'), 'utf8');
  for (const [name, mount] of [['chat', '/api/chat'], ['payments', '/api/payments']]) {
    t.match(server, new RegExp(`app\\.use\\('${mount.replace('/', '\\/')}'`), `server.js mounts ${name} at ${mount}`);
    t.match(api, new RegExp(`app\\.use\\('${mount.replace('/', '\\/')}'`), `api/index.js mounts ${name} at ${mount}`);
    t.match(server, new RegExp(`require\\('\\./routes\\/${name}'\\)`), `server.js requires the ${name} router`);
    t.match(api, new RegExp(`require\\('\\.\\.\\/backend\\/routes\\/${name}'\\)`), `api/index.js requires the ${name} router`);
  }
  // The runtime config must be registered before the SPA catch-all, otherwise
  // /rev-runtime.js is answered with index.html and the frontend cannot tell
  // that the API is same-origin. Comments are stripped first, because the
  // explanatory comment mentions both routes and would confuse the comparison.
  const apiCode = api.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  t.ok(apiCode.indexOf('/rev-runtime.js') < apiCode.indexOf("app.get('*'"), 'api/index.js serves /rev-runtime.js before the catch-all page route');
  t.ok(server.indexOf('/rev-runtime.js') > 0, 'server.js serves /rev-runtime.js');
});

t.done();

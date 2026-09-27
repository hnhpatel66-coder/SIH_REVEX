// CORS behaviour, including the failure that broke login on Render.
//
// Regression context: the app was deployed to Render, where the pages and /api
// are served by the same process, so the browser sends
//   Origin: https://<app>.onrender.com
// The old allowlist only contained localhost origins plus FRONTEND_URL, which
// is unset in a fresh Render service, so every POST /api/auth/login was
// rejected with "Origin not allowed by CORS policy" and the browser surfaced it
// as a CORS error.
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { corsMiddleware, originAllowed, selfOrigin, configuredOrigins } = require('../backend/utils/security');

let pass = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// A throwaway Express server that speaks only the CORS middleware, so the test
// exercises the real request/response objects without touching the database or
// the port the dev server uses.
function serve() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(corsMiddleware());
  app.all('*', (req, res) => res.json({ ok: true, path: req.url }));
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise(done => server.close(done))
    }));
  });
}

function request(port, { method = 'GET', path = '/api/health', host, origin, requestHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(requestHeaders || {}) };
    if (origin) headers.Origin = origin;
    if (host) {
      // The test dials 127.0.0.1 but pretends to be reached through a proxy
      // that rewrote Host / X-Forwarded-*, exactly as Render does.
      headers.Host = host;
      const scheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
      headers['X-Forwarded-Host'] = host;
      headers['X-Forwarded-Proto'] = scheme;
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('\nCORS checks\n');

  const app = await serve();
  const { port } = app;

  try {
    /* ------------------------------------------------- the Render regression */

    await check('a Render same-origin preflight is allowed with no configuration', async () => {
      const res = await request(port, {
        method: 'OPTIONS',
        path: '/api/auth/login',
        host: 'revex-abc123.onrender.com',
        origin: 'https://revex-abc123.onrender.com',
        requestHeaders: {
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type'
        }
      });
      assert.equal(res.status, 204, `expected 204, got ${res.status}: ${res.body}`);
      assert.equal(res.headers['access-control-allow-origin'], 'https://revex-abc123.onrender.com');
      assert.match(String(res.headers['access-control-allow-methods']), /POST/);
      assert.match(String(res.headers['access-control-allow-headers']).toLowerCase(), /content-type/);
    });

    await check('a Render same-origin login POST is allowed (the reported failure)', async () => {
      const res = await request(port, {
        method: 'POST',
        path: '/api/auth/login',
        host: 'revex-abc123.onrender.com',
        origin: 'https://revex-abc123.onrender.com',
        requestHeaders: { 'Content-Type': 'application/json' }
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
      assert.equal(res.headers['access-control-allow-origin'], 'https://revex-abc123.onrender.com');
      assert.equal(res.headers['access-control-allow-credentials'], 'true');
    });

    await check('same-origin works for a custom Render domain too', async () => {
      const res = await request(port, {
        method: 'POST',
        host: 'revex.custom-domain.com',
        origin: 'https://revex.custom-domain.com'
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers['access-control-allow-origin'], 'https://revex.custom-domain.com');
    });

    await check('selfOrigin reads the client-facing host and scheme from the proxy headers', () => {
      const req = { headers: { host: 'internal:10000', 'x-forwarded-host': 'revex-abc123.onrender.com', 'x-forwarded-proto': 'https' }, protocol: 'http' };
      assert.equal(selfOrigin(req), 'https://revex-abc123.onrender.com');
    });

    await check('same-origin tolerates a trailing slash and different casing', () => {
      const req = { headers: { host: 'REVEX-ABC123.onrender.com' }, protocol: 'https' };
      const bare = selfOrigin(req);
      assert.equal(bare, 'https://revex-abc123.onrender.com');
    });

    /* ------------------------------------------------------------ still safe */

    await check('an unrelated site is still blocked', async () => {
      const res = await request(port, {
        method: 'POST',
        host: 'revex-abc123.onrender.com',
        origin: 'https://evil.example.net'
      });
      assert.equal(res.status, 403, `expected 403, got ${res.status}`);
      assert.match(res.body, /Origin not allowed by CORS policy/);
    });

    await check('an unrelated site is blocked on preflight too', async () => {
      const res = await request(port, {
        method: 'OPTIONS',
        host: 'revex-abc123.onrender.com',
        origin: 'https://evil.example.net',
        requestHeaders: { 'Access-Control-Request-Method': 'POST' }
      });
      assert.equal(res.status, 403);
      assert.ok(!res.headers['access-control-allow-origin'], 'must not grant a blocked origin');
    });

    await check('a near-miss lookalike host is blocked', async () => {
      const res = await request(port, {
        method: 'POST',
        host: 'revex-abc123.onrender.com',
        origin: 'https://revex-abc123.onrender.com.evil.example'
      });
      assert.equal(res.status, 403, 'suffix spoof must not be treated as same-origin');
    });

    await check('the rejection names the origin so the fix is diagnosable', async () => {
      const res = await request(port, {
        method: 'POST',
        host: 'revex-abc123.onrender.com',
        origin: 'https://evil.example.net'
      });
      const payload = JSON.parse(res.body);
      assert.equal(payload.rejectedOrigin, 'https://evil.example.net');
      assert.equal(payload.appOrigin, 'https://revex-abc123.onrender.com');
      assert.ok(payload.hint, 'no remediation hint returned');
    });

    await check('localhost development origins are still allowed', async () => {
      for (const origin of ['http://localhost:5001', 'http://localhost:5500', 'http://127.0.0.1:3000']) {
        const res = await request(port, { method: 'POST', host: 'localhost:5001', origin });
        assert.equal(res.status, 200, `${origin} was rejected`);
        assert.equal(res.headers['access-control-allow-origin'], origin);
      }
    });

    await check('a request with no Origin still succeeds (curl, health check)', async () => {
      const res = await request(port, { method: 'GET', host: 'revex-abc123.onrender.com' });
      assert.equal(res.status, 200);
    });

    await check('responses vary on Origin so a CDN cannot cross-serve them', async () => {
      const res = await request(port, {
        method: 'POST',
        host: 'revex-abc123.onrender.com',
        origin: 'https://revex-abc123.onrender.com'
      });
      assert.match(String(res.headers.vary), /Origin/i);
    });

    /* -------------------------------------------------------- allowlist rules */

    await check('originAllowed reads CORS_ALLOWED_ORIGINS and FRONTEND_URL', () => {
      const savedCors = process.env.CORS_ALLOWED_ORIGINS;
      const savedFront = process.env.FRONTEND_URL;
      try {
        process.env.CORS_ALLOWED_ORIGINS = 'https://a.example.com, .b.example.com';
        process.env.FRONTEND_URL = 'https://legacy.example.com/';
        assert.deepEqual(configuredOrigins().sort(), ['.b.example.com', 'https://a.example.com', 'https://legacy.example.com']);
        assert.equal(originAllowed('https://a.example.com'), true);
        assert.equal(originAllowed('https://deep.b.example.com'), true);
        assert.equal(originAllowed('https://b.example.com'), true);
        assert.equal(originAllowed('https://legacy.example.com'), true, 'trailing slash should be ignored');
        assert.equal(originAllowed('https://notb.example.com'), false);
        assert.equal(originAllowed('https://a.example.com.evil.net'), false);
      } finally {
        if (savedCors === undefined) delete process.env.CORS_ALLOWED_ORIGINS; else process.env.CORS_ALLOWED_ORIGINS = savedCors;
        if (savedFront === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = savedFront;
      }
    });

    await check('originAllowed requires an exact match for plain origins', () => {
      const saved = process.env.CORS_ALLOWED_ORIGINS;
      try {
        process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
        assert.equal(originAllowed('https://app.example.com'), true);
        assert.equal(originAllowed('http://app.example.com'), true, 'http/https variant should be tolerated');
        assert.equal(originAllowed('https://app.example.com:8443'), false, 'a different port is a different origin');
        assert.equal(originAllowed('https://sub.app.example.com'), false);
        assert.equal(originAllowed('https://other.example.com'), false);
      } finally {
        if (saved === undefined) delete process.env.CORS_ALLOWED_ORIGINS; else process.env.CORS_ALLOWED_ORIGINS = saved;
      }
    });

    await check('a wildcard entry allows any origin', () => {
      const saved = process.env.CORS_ALLOWED_ORIGINS;
      try {
        process.env.CORS_ALLOWED_ORIGINS = '*';
        assert.equal(originAllowed('https://anything.example'), true);
      } finally {
        if (saved === undefined) delete process.env.CORS_ALLOWED_ORIGINS; else process.env.CORS_ALLOWED_ORIGINS = saved;
      }
    });
  } finally {
    await app.close();
  }

  console.log(`\n${'-'.repeat(58)}`);
  console.log(`PASSED: ${pass}    FAILED: ${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f.name}: ${f.message}`); process.exit(1); }
  console.log('All CORS checks passed.');
})().catch(e => { console.error('FATAL', e); process.exit(1); });

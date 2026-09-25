// Development origins that are always allowed. The backend runs on 5001; the
// others are the common local static/dev servers a developer might open the
// pages from (VS Code Live Server, Live Preview, Vite, etc). Production origins
// come from CORS_ALLOWED_ORIGINS / FRONTEND_URL, and a same-origin request is
// always allowed without any configuration at all.
const API_PORT = process.env.PORT || 5001;
const DEV_PORTS = [5000, API_PORT, 3000, 4200, 5173, 5500, 8080, 8081];
const LOCAL_ORIGINS = DEV_PORTS.flatMap(port => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`
]);

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'Content-Type, Authorization';
const PREFLIGHT_MAX_AGE = '600';

function stripTrailingSlash(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function normalizeOrigin(value) { return stripTrailingSlash(value).toLowerCase(); }

/**
 * Extra origins the operator allows, comma separated.
 *
 * CORS_ALLOWED_ORIGINS is the canonical name. FRONTEND_URL is still read so an
 * existing deployment keeps working. Three forms are supported:
 *   https://app.example.com   exact origin
 *   .example.com              any subdomain (and the bare domain)
 *   *                         any origin -- only for a public read-only API
 */
function configuredOrigins() {
  const raw = [process.env.CORS_ALLOWED_ORIGINS, process.env.FRONTEND_URL]
    .filter(Boolean)
    .join(',');
  return raw.split(',').map(stripTrailingSlash).filter(Boolean);
}

/**
 * The origin the browser is actually talking to, reconstructed from the request.
 * Behind Render/Railway the app is reached through a proxy, so the scheme the
 * client used arrives in X-Forwarded-Proto and the public host in Host.
 *
 * This is what makes a Render deployment work with no CORS configuration: the
 * pages and /api are served by the same process, so the Origin header always
 * equals the app's own public origin.
 */
function selfOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim();
  if (!host) return '';
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0].trim();
  return normalizeOrigin(`${proto}://${host}`);
}

function isLocalOrigin(origin) {
  const value = normalizeOrigin(origin);
  if (LOCAL_ORIGINS.includes(value)) return true;
  // The https variant of a local http origin (Live Preview tunnels, and
  // browsers that upgrade localhost to a secure context).
  return LOCAL_ORIGINS.includes(value.replace(/^https:/, 'http:'));
}

function originAllowed(origin, list = configuredOrigins()) {
  const value = normalizeOrigin(origin);
  if (!value) return false;
  if (isLocalOrigin(value)) return true;
  return list.some(entry => {
    const rule = normalizeOrigin(entry);
    if (rule === '*') return true;
    if (rule.startsWith('.')) {
      // Suffix rule: ".example.com" allows a.example.com and example.com.
      try {
        const host = new URL(value).hostname.toLowerCase();
        return host === rule.slice(1) || host.endsWith(rule);
      } catch { return false; }
    }
    return rule === value || rule === value.replace(/^https:/, 'http:') || rule === value.replace(/^http:/, 'https:');
  });
}

/**
 * CORS as a small hand-written middleware.
 *
 * The `cors` package's `origin` callback receives only (origin, callback) --
 * it never sees the request -- so it cannot tell "this is the app calling
 * itself on Render" from "this is an untrusted site". That is exactly the
 * failure that broke login on the Render deployment: the browser sends
 * `Origin: https://<app>.onrender.com` and the fixed allowlist (localhost +
 * FRONTEND_URL) rejected it.
 */
function corsMiddleware() {
  const list = configuredOrigins();
  return function (req, res, next) {
    const origin = req.headers.origin;

    // No Origin at all: same-origin GETs, curl, health checks, server-to-server.
    if (!origin) {
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    }

    // Append to Vary rather than overwrite, so a CDN never caches one
    // origin's response and serves it to another.
    const vary = res.getHeader('Vary');
    const varyValue = vary ? `${vary}, Origin` : 'Origin';
    res.setHeader('Vary', varyValue);

    const self = selfOrigin(req);
    const sameOrigin = self && normalizeOrigin(origin) === self;

    if (!sameOrigin && !originAllowed(origin, list)) {
      return res.status(403).json({
        message: 'Origin not allowed by CORS policy.',
        hint: 'Add this origin to CORS_ALLOWED_ORIGINS, or serve the pages and the API from the same host.',
        rejectedOrigin: stripTrailingSlash(origin),
        appOrigin: self || null
      });
    }

    // Reflect the caller's origin rather than "*", which is required for
    // credentialed requests.
    res.setHeader('Access-Control-Allow-Origin', stripTrailingSlash(origin));
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] || DEFAULT_ALLOWED_HEADERS
    );
    res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);

    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

// Retained for callers that only need the allowlist shape (tests, the Vercel
// entry point's documentation). The runtime uses corsMiddleware().
function corsOptions() {
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (originAllowed(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS policy.'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  };
}

// Files that must never be reachable over the public static server even though
// they sit inside the project root (audit M14).
const BLOCKED_STATIC = [
  /^\/(backend|node_modules|tests)(\/|$)/i,
  /^\/\.env/i,
  /^\/\.git/i,
  /\.(bat|cmd|ps1|sh|env|npmrc|log)$/i,
  /^\/(package(-lock)?\.json|vercel\.json|jsconfig\.json|tsconfig\.json)$/i
];

function blockPrivateStatic(req, res, next) {
  const target = decodeURIComponent((req.path || '').split('?')[0]);
  if (BLOCKED_STATIC.some(pattern => pattern.test(target))) return res.status(404).end();
  next();
}

/**
 * Safety net for JSON bodies that arrived without a proper Content-Type.
 *
 * express.json() silently leaves req.body as {} when the request has no
 * application/json content type, which turns a valid request into a confusing
 * "field is required" validation error. If the raw body still looks like JSON
 * we parse it here so the API behaves predictably.
 */
function jsonBodyFallback() {
  return (req, res, next) => {
    if (req.body && Object.keys(req.body).length) return next();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('application/json')) return next(); // already parsed or empty

    const raw = req.rawBody || req.body;
    if (!raw) return next();
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : (typeof raw === 'string' ? raw : '');
    const trimmed = text.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return next();
    try {
      req.body = JSON.parse(trimmed);
    } catch {
      return next(); // genuinely malformed JSON: let the normal handler reject it
    }
    next();
  };
}

module.exports = {
  corsOptions,
  corsMiddleware,
  blockPrivateStatic,
  jsonBodyFallback,
  BLOCKED_STATIC,
  LOCAL_ORIGINS,
  configuredOrigins,
  originAllowed,
  selfOrigin
};

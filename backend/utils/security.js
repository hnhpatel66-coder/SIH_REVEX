// Development origins that are always allowed. The backend runs on 5001; the
// others are the common local static/dev servers a developer might open the
// pages from (VS Code Live Server, Live Preview, Vite, etc). Production origins
// still come from FRONTEND_URL.
const API_PORT = process.env.PORT || 5001;
const DEV_PORTS = [5000, API_PORT, 3000, 4200, 5173, 5500, 8080, 8081];
const LOCAL_ORIGINS = DEV_PORTS.flatMap(port => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`
]);

// A single source of truth shared by backend/server.js and api/index.js so the
// two entry points cannot drift apart.
function corsOptions() {
  const configured = String(process.env.FRONTEND_URL || '').split(',').map(value => value.trim()).filter(Boolean);
  const allowed = new Set([...LOCAL_ORIGINS, ...configured]);
  return {
    origin(origin, callback) {
      // Same-origin / server-to-server / curl requests have no Origin header.
      if (!origin) return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      // https variant of a configured http origin (e.g. Live Preview tunnels)
      if (allowed.has(origin.replace(/^http:/, 'https:'))) return callback(null, true);
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

module.exports = { corsOptions, blockPrivateStatic, jsonBodyFallback, BLOCKED_STATIC, LOCAL_ORIGINS };

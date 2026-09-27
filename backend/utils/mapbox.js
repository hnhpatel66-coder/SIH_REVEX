/**
 * MAPBOX PROVIDER  (backend/utils/mapbox.js)
 *
 * Every network call the smart-route feature makes goes through this one file,
 * so there is exactly one place that knows:
 *   - which environment variables hold the tokens,
 *   - what the Mapbox request/response shapes are,
 *   - what happens when no token is configured.
 *
 * SECRETS
 *
 * MAPBOX_ACCESS_TOKEN (or the legacy MAPBOX_TOKEN) is a SECRET token and is
 * used only here, server side, for geocoding and directions. It is never sent
 * to the browser.
 *
 * MAPBOX_PUBLIC_TOKEN is the PUBLISHABLE `pk.` token used by Mapbox GL JS in
 * the browser. It is safe to expose: that is what it is for. It is returned
 * from GET /api/rides/map-config and nothing else.
 *
 * THE THREE ROAD-DATA TIERS
 *
 *   1. "mapbox"    MAPBOX_ACCESS_TOKEN is set. Real Mapbox Directions v5
 *                  geometry, Mapbox Geocoding v5 place names. The intended
 *                  production configuration.
 *
 *   2. "osrm"      No Mapbox token, but the public OSRM routing service is
 *                  reachable. REAL road geometry, no API key required. This is
 *                  what makes the feature work on a fresh clone with an empty
 *                  .env - the Junagadh -> Rajkot -> Ahmedabad story is a real
 *                  road, and only real road data can reproduce it. (A straight
 *                  line cannot: Rajkot sits about 47 km off the direct
 *                  Junagadh-Ahmedabad line, because the road goes the long way
 *                  round through it.)
 *
 *   3. "estimate"  Neither is available. The route becomes a straight line
 *                  between the two towns and the result says so, plainly, in
 *                  `provider` and `note`. The UI shows "route estimated" rather
 *                  than pretending it has road data.
 *
 * Matching, distance pricing and the map all keep working in every tier. Only
 * the accuracy of the road shape changes, and the app never misreports which
 * tier produced a number.
 */
'use strict';

const geo = require('./geo');

const DEFAULT_GEOCODING_BASE = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
const DEFAULT_DIRECTIONS_BASE = 'https://api.mapbox.com/directions/v5/mapbox/driving';
const DEFAULT_PUBLIC_ROUTER_BASE = 'https://router.project-osrm.org/route/v1/driving';
const DEFAULT_STYLE_URL = 'mapbox://styles/mapbox/streets-v12';
const DEFAULT_GL_VERSION = '3.9.4';
const DEFAULT_TIMEOUT_MS = 8000;

/*
 * A pickup is a CITY CENTRE while the road is a HIGHWAY BYPASS, so the two are
 * routinely ~10 km apart even though everybody agrees the driver "goes to
 * Rajkot". The default tolerances are set for that reality: a few km would
 * reject almost every real city pickup, and a huge tolerance would let a point
 * on the wrong side of a district match. 10 km for the rider's own points, 12 km
 * for deciding which towns the road passes through.
 */
const DEFAULT_ROUTE_TOLERANCE_KM = 10;
const DEFAULT_VIA_TOLERANCE_KM = 12;
/** A rider joining at least this far along the route is treated as mid-route. */
const DEFAULT_MID_ROUTE_KM = 5;

function clean(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round1(value) {
  return Math.round(num(value, 0) * 10) / 10;
}

/**
 * Mapbox tokens are `pk.…` (public) or `sk.…` (secret).
 *
 * The prefix match is deliberately case-SENSITIVE. Mapbox only ever issues
 * lower-case tokens, so a mis-cased one cannot work anyway - and treating `SK.…`
 * as anything but unknown is the one mistake with teeth, because an unrecognised
 * secret must fall back to the key-free provider rather than be handed to a
 * browser. Comparing case-insensitively would put a secret-looking string into
 * the public token and ship it to every rider's page.
 */
function tokenKind(token) {
  const value = clean(token, 200);
  if (!value) return '';
  if (/^(pk|sk)\./.test(value)) return value.slice(0, 2);
  return 'unknown';
}

function isPublicToken(token) {
  return tokenKind(token) === 'pk';
}

function isSecretToken(token) {
  return tokenKind(token) === 'sk';
}

/**
 * The whole provider decision, derived from the environment. Pure and testable,
 * so "is the map configured?" has exactly one answer for the API, the UI and the
 * boot log.
 */
function providerConfig(env = process.env) {
  const secret = clean(env.MAPBOX_ACCESS_TOKEN || env.MAPBOX_TOKEN, 200);
  const publicToken = clean(env.MAPBOX_PUBLIC_TOKEN, 200);
  const publicRouterBase = clean(env.SMART_ROUTE_PUBLIC_ROUTER_BASE, 300) || DEFAULT_PUBLIC_ROUTER_BASE;
  // A public token is enough for GL JS. A secret token also drives the REST APIs.
  // If only the public one is set, the browser still gets a working map and the
  // server says plainly that server-side road routing is not available.
  const routingReady = Boolean(secret);

  return {
    /** Mapbox REST geocoding + directions can be called. */
    routingReady,
    /** The browser can draw a real Mapbox map. */
    mapReady: Boolean(publicToken) || Boolean(secret),
    secret,
    publicToken,
    // A `sk.` token is NOT handed to the browser: it would be a public secret.
    // If only a secret token exists, the UI falls back to the built-in map.
    browserToken: isPublicToken(publicToken) ? publicToken : (isPublicToken(secret) ? secret : ''),
    styleUrl: clean(env.MAPBOX_STYLE_URL, 400) || DEFAULT_STYLE_URL,
    glVersion: clean(env.MAPBOX_GL_VERSION, 20) || DEFAULT_GL_VERSION,
    country: clean(env.MAPBOX_COUNTRY, 8) || 'in',
    geocodingBase: clean(env.MAPBOX_GEOCODING_BASE, 300) || DEFAULT_GEOCODING_BASE,
    directionsBase: clean(env.MAPBOX_DIRECTIONS_BASE, 300) || DEFAULT_DIRECTIONS_BASE,
    publicRouterBase,
    publicRouterEnabled: String(env.SMART_ROUTE_PUBLIC_ROUTER_ENABLED ?? 'true').toLowerCase() !== 'false',
    fallbackEnabled: String(env.MAPBOX_FALLBACK_ENABLED ?? 'true').toLowerCase() !== 'false',
    timeoutMs: clamp(num(env.MAPBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS), 1000, 60000),
    cacheTtlMs: clamp(num(env.MAPBOX_CACHE_TTL_MS, 600000), 0, 86400000),
    cacheMaxEntries: clamp(Math.trunc(num(env.MAPBOX_CACHE_MAX_ENTRIES, 500)), 0, 10000),
    toleranceKm: clamp(num(env.MAPBOX_ROUTE_TOLERANCE_KM, DEFAULT_ROUTE_TOLERANCE_KM), 0.5, 100),
    viaToleranceKm: clamp(num(env.MAPBOX_VIA_TOLERANCE_KM, DEFAULT_VIA_TOLERANCE_KM), 0.5, 50),
    viaLimit: clamp(Math.trunc(num(env.MAPBOX_VIA_LIMIT, 6)), 0, 20),
    midRouteKm: clamp(num(env.SMART_ROUTE_MID_ROUTE_KM, DEFAULT_MID_ROUTE_KM), 0, 100),
    minTravelKm: clamp(num(env.SMART_ROUTE_MIN_TRAVEL_KM, geo.MIN_TRAVEL_KM), 0, 100),
    minMatchFraction: clamp(num(env.MAPBOX_MIN_MATCH_FRACTION, 0.03), 0, 0.9),
    maxHeadingDifferenceDeg: clamp(num(env.SMART_ROUTE_MAX_HEADING_DIFFERENCE_DEG, geo.MAX_HEADING_DIFFERENCE_DEG), 10, 180)
  };
}

/** Why server-side road routing is unavailable, for the boot log and the UI. */
function routingProblem(env = process.env) {
  const config = providerConfig(env);
  if (config.routingReady) return '';
  if (config.publicRouterEnabled) {
    return 'MAPBOX_ACCESS_TOKEN is not set, so road routing falls back to the key-free public OSRM service. Set it for Mapbox Directions and Mapbox Geocoding.';
  }
  return 'No Mapbox access token is set and the public road-routing fallback is switched off, so routes are straight-line estimates.';
}

/** What the browser is allowed to know. Never contains the secret token. */
function publicConfig(env = process.env) {
  const config = providerConfig(env);
  return {
    enabled: Boolean(config.browserToken),
    token: config.browserToken,
    styleUrl: config.styleUrl,
    glVersion: config.glVersion,
    /** Read by the client loader so it can build the CDN URLs itself. */
    glScriptUrl: `https://api.mapbox.com/mapbox-gl-js/v${config.glVersion}/mapbox-gl.js`,
    glStyleUrl: `https://api.mapbox.com/mapbox-gl-js/v${config.glVersion}/mapbox-gl.css`,
    routingReady: config.routingReady,
    provider: config.routingReady ? 'mapbox' : (config.publicRouterEnabled ? 'osrm' : 'estimate'),
    toleranceKm: config.toleranceKm,
    reason: config.browserToken ? '' : 'MAPBOX_PUBLIC_TOKEN (a pk.… token) is not set, so the interactive Mapbox map is disabled and the built-in route map is shown instead.'
  };
}

/* ------------------------------------------------------------------ cache */

/**
 * A tiny TTL cache. Every geocoding and directions call goes to the network, so
 * without this the Find Ride page would spend several hundred milliseconds per
 * search and could burn a monthly request allowance in one go.
 * Bounded in BOTH time and size, so it can never grow without limit.
 */
const cache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) { cacheMisses += 1; return undefined; }
  const ttl = providerConfig().cacheTtlMs;
  if (ttl <= 0 || Date.now() - entry.at > ttl) { cache.delete(key); cacheMisses += 1; return undefined; }
  cacheHits += 1;
  return entry.value;
}

function cacheSet(key, value) {
  const { cacheMaxEntries, cacheTtlMs } = providerConfig();
  if (cacheMaxEntries <= 0 || cacheTtlMs <= 0) return value;
  // Re-insert so the key becomes the most recently used, then evict the oldest.
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > cacheMaxEntries) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return value;
}

function clearCache() { cache.clear(); cacheHits = 0; cacheMisses = 0; }

function cacheStats() {
  return { size: cache.size, hits: cacheHits, misses: cacheMisses };
}

/* --------------------------------------------------------------- transport */

async function fetchJson(url, { timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || providerConfig().timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {},
      error: error.name === 'AbortError' ? 'the routing provider timed out' : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------- geocoding */

/**
 * Turns what a rider typed into a coordinate.
 *
 * Order of preference:
 *   1. an explicit `lng`/`lat` (a pin dropped on the map) - never geocoded,
 *   2. Mapbox Geocoding v5,
 *   3. the built-in gazetteer.
 *
 * Never throws. A search box that throws on an unknown town is a search box that
 * loses the whole search, so an unresolved name comes back as `{ found: false }`
 * and the caller decides what to say.
 */
async function geocode(query, options = {}) {
  const config = providerConfig();
  const explicit = geo.toCoordinate([options.lng, options.lat]);
  if (options.lng !== undefined && options.lat !== undefined && explicit) {
    return { found: true, name: clean(options.name, 120) || 'Pinned location', coordinate: explicit, provider: 'pin', placeName: clean(options.name, 160) || 'Pinned location' };
  }

  const text = clean(query, 120);
  if (!text) return { found: false, reason: 'empty' };

  const key = `geo:${config.country}:${text.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  if (config.routingReady) {
    const url = new URL(`${config.geocodingBase}/${encodeURIComponent(text)}.json`);
    url.searchParams.set('access_token', config.secret);
    url.searchParams.set('limit', '5');
    url.searchParams.set('types', 'place,address,locality,district,region');
    if (config.country) url.searchParams.set('country', config.country);
    if (options.proximity) {
      const near = geo.toCoordinate(options.proximity);
      if (near) url.searchParams.set('proximity', `${near[0]},${near[1]}`);
    }
    const { ok, data } = await fetchJson(url.toString());
    if (ok) {
      const feature = (data?.features || []).find(entry => geo.isCoordinate(entry?.center));
      if (feature) {
        return cacheSet(key, {
          found: true,
          name: clean(feature.text || feature.place_name, 120),
          placeName: clean(feature.place_name, 200),
          coordinate: geo.toCoordinate(feature.center),
          provider: 'mapbox',
          placeType: clean(feature.place_type?.[0], 40)
        });
      }
    }
    // A Mapbox miss is not fatal: the gazetteer below may still know the place.
  }

  if (!config.fallbackEnabled) return cacheSet(key, { found: false, reason: 'not_found' });

  const local = geo.gazetteerLookup(text);
  if (local) {
    return cacheSet(key, {
      found: true,
      name: local.name,
      placeName: local.name,
      coordinate: local.coordinate,
      provider: 'gazetteer',
      placeType: 'place'
    });
  }
  return cacheSet(key, { found: false, reason: 'not_found' });
}

/**
 * Puts a NAME on a coordinate a rider dropped as a pin.
 *
 * Strictly a labelling step: the returned object never carries a coordinate, so
 * it is impossible for this to move a pin. That separation is the whole point -
 * a pin is the rider's own decision about where to be picked up, and the only
 * thing missing from it is a word for the card.
 *
 * The name is allowed to fail. It degrades to the nearest gazetteer town, and
 * then to nothing, because every number in the match is already decided by the
 * coordinate. A ride shown as "Pinned location, 154.5 km along" is still
 * bookable and still correctly priced; it is just less pleasant to read.
 */
async function reverseGeocode(coordinate) {
  const point = geo.toCoordinate(coordinate);
  if (!point) return { name: '', provider: 'none' };
  // Rounded to ~10 m, so repeated pins of the same spot share one cache entry
  // instead of one entry each.
  const key = `rev:${point[0].toFixed(4)},${point[1].toFixed(4)}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const config = providerConfig();
  let result = { name: '', provider: 'none' };

  if (config.routingReady) {
    const url = new URL(`${config.geocodingBase}/${point[0].toFixed(5)},${point[1].toFixed(5)}.json`);
    url.searchParams.set('access_token', config.secret);
    url.searchParams.set('types', 'place,locality,district,region');
    url.searchParams.set('limit', '1');
    if (config.country) url.searchParams.set('country', config.country);
    const { ok, data } = await fetchJson(url.toString());
    if (ok) {
      const feature = (data?.features || [])[0];
      const name = clean(feature?.text, 120) || clean(feature?.place_name, 120);
      if (name) result = { name, placeName: clean(feature?.place_name, 200), provider: 'mapbox' };
    }
  }

  if (!result.name && config.fallbackEnabled) {
    const near = geo.nearestPlace(point, 25);
    if (near) result = { name: near.name, provider: 'gazetteer' };
  }
  return cacheSet(key, result);
}

/* -------------------------------------------------------------- directions */

/** Shapes a routing result, whatever the provider. */
function roadResult(provider, coordinates, distanceKm, durationMin, via, note = '') {
  const line = geo.toLineCoordinates(coordinates);
  if (!line) return null;
  const measured = geo.measureLine(line);
  return {
    ok: true,
    provider,
    coordinates: line,
    distanceKm: distanceKm > 0 ? distanceKm : measured.totalKm,
    durationMin: Math.max(0, Math.round(durationMin)),
    via: via || [],
    note
  };
}

function withVia(result, options, config) {
  if (!result) return null;
  return {
    ...result,
    via: geo.viaPointsAlongRoute(result.coordinates, {
      toleranceKm: config.viaToleranceKm,
      limit: config.viaLimit,
      exclude: [options.fromName, options.toName]
    })
  };
}

/** Mapbox Directions v5. The intended production path. */
async function mapboxDirections(start, end, config) {
  const url = new URL(`${config.directionsBase}/${start[0]},${start[1]};${end[0]},${end[1]}`);
  url.searchParams.set('access_token', config.secret);
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('steps', 'false');
  const { ok, data, error } = await fetchJson(url.toString());
  if (!ok) return { ok: false, error };
  const route = data?.routes?.[0];
  return roadResult('mapbox', route?.geometry?.coordinates, num(route?.distance, 0) / 1000, num(route?.duration, 0) / 60);
}

/**
 * The public OSRM routing service - real road geometry, no API key.
 *
 * Used only when no Mapbox secret token is configured, so a fresh clone still
 * gets real roads instead of straight lines. Its answers are cached, and any
 * failure falls through to the estimate rather than surfacing as an error.
 */
async function publicRouterDirections(start, end, config) {
  const url = new URL(`${config.publicRouterBase}/${start[0]},${start[1]};${end[0]},${end[1]}`);
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  const { ok, data, error } = await fetchJson(url.toString());
  if (!ok) return { ok: false, error };
  const route = data?.routes?.[0];
  return roadResult('osrm', route?.geometry?.coordinates, num(route?.distance, 0) / 1000, num(route?.duration, 0) / 60);
}

/**
 * The road route between two coordinates.
 *
 * Returns the full GeoJSON line, the driving distance in km, the duration in
 * minutes and the towns it passes through, tagged with the provider that
 * produced them so nothing downstream can mistake an estimate for road data.
 */
async function directions(from, to, options = {}) {
  const config = providerConfig();
  const start = geo.toCoordinate(from);
  const end = geo.toCoordinate(to);
  if (!start || !end) return { ok: false, reason: 'invalid_coordinates' };

  const key = `dir:${start[0].toFixed(4)},${start[1].toFixed(4)};${end[0].toFixed(4)},${end[1].toFixed(4)}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const finish = payload => cacheSet(key, payload);

  if (config.routingReady) {
    const result = await mapboxDirections(start, end, config);
    const shaped = withVia(result, options, config);
    if (shaped?.ok) return finish(shaped);
    if (result?.error) console.warn('[mapbox] directions failed, trying the fallback router:', result.error);
  }

  if (config.fallbackEnabled && config.publicRouterEnabled) {
    const result = await publicRouterDirections(start, end, config);
    const shaped = withVia(result, options, config);
    if (shaped?.ok) return finish({ ...shaped, note: 'Real road geometry from the key-free public OSRM service, because no Mapbox access token is configured.' });
    if (result?.error) console.warn('[smart-route] public road router failed, using the straight-line estimate:', result.error);
  }

  if (!config.fallbackEnabled) return finish({ ok: false, reason: 'routing_unavailable' });

  const coordinates = geo.straightLine([start, end], 5);
  const distanceKm = geo.haversineKm(start, end);
  const estimated = {
    ok: true,
    provider: 'estimate',
    coordinates,
    distanceKm,
    durationMin: Math.max(1, Math.round((distanceKm / 42) * 60)),   // ~42 km/h average
    via: geo.viaPointsAlongRoute(coordinates, {
      toleranceKm: config.viaToleranceKm,
      limit: config.viaLimit,
      exclude: [options.fromName, options.toName]
    }),
    note: 'Straight-line estimate between the two towns. Set MAPBOX_ACCESS_TOKEN for real Mapbox road routing.'
  };
  return finish(estimated);
}

/**
 * Builds (or rebuilds) the route for a ride from its two town names.
 *
 * This is the one entry point the routes call, so the "geocode both ends, then
 * route them, then work out the via towns" sequence exists once. It NEVER
 * throws: a ride must be creatable on a machine with no Mapbox token, and a
 * failed route must never block the offer the owner already paid attention to.
 */
async function buildRoute({ from, to } = {}) {
  const config = providerConfig();
  const origin = await geocode(from);
  if (!origin.found) {
    return { ok: false, reason: 'origin_not_found', from, to, error: `"${from}" could not be located.` };
  }
  const destination = await geocode(to, { proximity: origin.coordinate });
  if (!destination.found) {
    return { ok: false, reason: 'destination_not_found', from, to, error: `"${to}" could not be located.` };
  }

  const route = await directions(origin.coordinate, destination.coordinate, { fromName: origin.name, toName: destination.name });
  if (!route.ok) {
    return {
      ok: false,
      reason: route.reason || 'route_unavailable',
      from, to,
      origin: origin.coordinate,
      destination: destination.coordinate,
      error: 'The road route between these two towns could not be calculated.'
    };
  }

  return {
    ok: true,
    provider: route.provider,
    originName: origin.name,
    destinationName: destination.name,
    origin: origin.coordinate,
    destination: destination.coordinate,
    coordinates: route.coordinates,
    distanceKm: round1(route.distanceKm),
    durationMin: route.durationMin,
    via: (route.via || []).map(point => ({
      name: point.name,
      coordinate: point.coordinate,
      alongKm: round1(point.alongKm)
    })),
    estimated: route.provider !== 'mapbox',
    note: route.note || '',
    toleranceKm: config.toleranceKm
  };
}

/**
 * The safe diagnostics behind the boot log. Reports WHETHER each value is
 * present and what it can do - never the value itself.
 */
function describeStatus(env = process.env) {
  const config = providerConfig(env);
  return {
    routingReady: config.routingReady,
    mapReady: config.mapReady,
    tokenKind: config.secret ? tokenKind(config.secret) : (config.publicToken ? tokenKind(config.publicToken) : 'none'),
    styleUrl: config.browserToken ? config.styleUrl : '',
    /** Which tier will produce road geometry. */
    roadDataSource: config.routingReady ? 'mapbox' : (config.publicRouterEnabled ? 'osrm' : 'estimate'),
    provider: config.routingReady ? 'mapbox' : (config.publicRouterEnabled ? 'osrm' : 'estimate'),
    toleranceKm: config.toleranceKm,
    cacheEntries: cache.size,
    problem: routingProblem(env)
  };
}

module.exports = {
  DEFAULT_GEOCODING_BASE,
  DEFAULT_DIRECTIONS_BASE,
  DEFAULT_PUBLIC_ROUTER_BASE,
  DEFAULT_STYLE_URL,
  DEFAULT_GL_VERSION,
  DEFAULT_ROUTE_TOLERANCE_KM,
  DEFAULT_VIA_TOLERANCE_KM,
  tokenKind,
  isPublicToken,
  isSecretToken,
  providerConfig,
  publicConfig,
  routingProblem,
  geocode,
  reverseGeocode,
  directions,
  buildRoute,
  describeStatus,
  clearCache,
  cacheStats
};

/**
 * ROUTE GEOMETRY  (backend/utils/geo.js)
 *
 * Pure, dependency-free geometry for the smart-route feature. It has NO
 * knowledge of Mapbox, of the environment or of the network, which is what makes
 * it unit-testable offline and what lets the whole feature keep working when no
 * Mapbox token is configured.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Before 1.4 a ride was "Junagadh -> Ahmedabad" and a rider searching
 * "Rajkot -> Ahmedabad" saw nothing, because the two were compared as text.
 * Junagadh->Ahmedabad physically passes through Rajkot, so that rider IS on
 * that ride, they simply start halfway.
 *
 * So a ride is no longer two strings. It is a POLYLINE: the actual road shape,
 * as an ordered list of [longitude, latitude] pairs. This module answers the
 * three questions the rest of the app then needs:
 *
 *   1. Is this point ON the route?           -> nearestOnRoute()
 *   2. How far along the route is it?        -> alongKm / fraction
 *   3. What part of the route is A..B?       -> sliceBetween()
 *
 * WHY THE TWO DISTANCES ARE COMPUTED DIFFERENTLY (and why that is correct)
 *
 *   - "how far along the route" is a long measurement, so it uses the haversine
 *     formula, which stays accurate over hundreds of kilometres.
 *   - "how far off the route" is a short measurement, so it uses a local
 *     equirectangular projection, which stays accurate for a few kilometres and
 *     is far cheaper than a haversine per vertex.
 *
 * Mixing them up is a real bug: using haversine for the perpendicular offset
 * over-estimates it by the cosine of the latitude (about 0.65x in Gujarat), so
 * a pin dropped exactly on the highway would read as several kilometres off it
 * and be rejected as "not on this route".
 *
 * Coordinates are always GeoJSON order: [longitude, latitude].
 */
'use strict';

const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

/** A pickup/drop point this far from the route is not "on" it. */
const DEFAULT_TOLERANCE_KM = 8;
/** Below this, joining is pointless (the rider would pay for almost nothing). */
const MIN_TRAVEL_KM = 5;
/**
 * The rider travelling a visibly different compass direction from the ride is
 * not joining it. 120 degrees is deliberately generous: it accepts any sensible
 * "along the same road" heading while rejecting the opposite one.
 */
const MAX_HEADING_DIFFERENCE_DEG = 120;

/* ------------------------------------------------------------- primitives */

function toRad(value) {
  return Number(value) * DEG;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** A coordinate pair is usable only if both numbers are in valid ranges. */
function isCoordinate(value) {
  return Array.isArray(value)
    && value.length >= 2
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]))
    && Math.abs(Number(value[0])) <= 180
    && Math.abs(Number(value[1])) <= 90;
}

/** Normalises anything coordinate-shaped into a clean [lng, lat] pair. */
function toCoordinate(value) {
  if (!isCoordinate(value)) return null;
  const lng = Number(value[0]);
  const lat = Number(value[1]);
  if (lng === 0 && lat === 0) return null;   // the classic "no data" null island
  return [lng, lat];
}

/**
 * Great-circle distance in kilometres. Used for the long "along the route"
 * measurement, where accuracy over hundreds of kilometres matters.
 */
function haversineKm(a, b) {
  const first = toCoordinate(a);
  const second = toCoordinate(b);
  if (!first || !second) return 0;
  const dLat = toRad(second[1] - first[1]);
  const dLng = toRad(second[0] - first[0]);
  const lat1 = toRad(first[1]);
  const lat2 = toRad(second[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Projects onto a local flat plane anchored at `lat0`.
 * Accurate to well under 1% for the few-kilometre offsets it is used for.
 */
function project(point, lat0) {
  const scale = Math.cos(toRad(lat0));
  return [toRad(point[0]) * scale * EARTH_RADIUS_KM, toRad(point[1]) * EARTH_RADIUS_KM];
}

/** Perpendicular distance from `point` to the segment a..b, in kilometres. */
function distanceToSegmentKm(point, a, b) {
  const p = project(point, a[1]);
  const s = project(a, a[1]);
  const e = project(b, a[1]);
  const dx = e[0] - s[0];
  const dy = e[1] - s[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p[0] - s[0], p[1] - s[1]);
  let t = ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (s[0] + t * dx), p[1] - (s[1] + t * dy));
}

/** Initial compass bearing from a to b, in degrees 0..360. */
function bearingDeg(a, b) {
  const first = toCoordinate(a);
  const second = toCoordinate(b);
  if (!first || !second) return 0;
  const lat1 = toRad(first[1]);
  const lat2 = toRad(second[1]);
  const dLng = toRad(second[0] - first[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Smallest absolute difference between two compass bearings, 0..180. */
function headingDifferenceDeg(a, b) {
  const diff = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return diff;
}

/* ------------------------------------------------------------- polyline io */

/**
 * Cleans any stored geometry into a usable polyline, or null if it is not one.
 *
 * Route geometry reaches this function from three different places, in three
 * different shapes, so all of them are accepted:
 *
 *   [lng, lat], [lng, lat], ...                     a bare coordinate array
 *   { type: "LineString", coordinates: [...] }      a GeoJSON geometry
 *   { type: "Feature", geometry: {...} }            a GeoJSON feature
 *   { type: "MultiLineString", coordinates: [[...]] }
 *   [ { type: "Feature", ... }, ... ]               a feature collection
 *
 * A multi-part shape (MultiLineString, GeometryCollection, a feature list) is
 * reduced to its LONGEST part, because a route is a single continuous line and
 * the longest part is the one that actually traces the journey.
 */
function toLineCoordinates(value) {
  if (value === null || value === undefined) return null;

  // Multi-part shapes: reduce to the longest line, recursively.
  if (Array.isArray(value) && value.length && Array.isArray(value[0]) && Array.isArray(value[0][0])) {
    const parts = value.map(part => toLineCoordinates(part)).filter(Boolean);
    if (!parts.length) return null;
    parts.sort((a, b) => b.length - a.length);
    return parts[0];
  }
  // A bare feature LIST: [{ type: 'Feature', geometry: {...} }, ...]. Distinguished
  // from a coordinate array by the first entry being a geometry object rather
  // than a number.
  if (Array.isArray(value) && value.length && value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])) {
    const parts = value.map(part => toLineCoordinates(part)).filter(Boolean);
    if (!parts.length) return null;
    parts.sort((a, b) => b.length - a.length);
    return parts[0];
  }
  if (value && value.type === 'Feature') return toLineCoordinates(value.geometry);
  // A MultiLineString arrives as a GEOMETRY OBJECT, not a bare nested array, so
  // the array check above cannot see it. This is not a rare shape: the public
  // OSRM router returns one for any route with more than one leg, and dropping
  // it here would silently leave those rides with no road at all.
  if (value && value.type === 'MultiLineString') return toLineCoordinates(value.coordinates);
  if (value && value.type === 'GeometryCollection' && Array.isArray(value.geometries)) {
    const parts = value.geometries.map(part => toLineCoordinates(part)).filter(Boolean);
    if (!parts.length) return null;
    parts.sort((a, b) => b.length - a.length);
    return parts[0];
  }

  const source = Array.isArray(value)
    ? value
    : (value && (value.type === 'LineString' || Array.isArray(value.coordinates)) ? value.coordinates : null);
  if (!Array.isArray(source) || source.length < 2) return null;
  const points = [];
  for (const entry of source) {
    const point = toCoordinate(entry);
    if (!point) continue;
    const previous = points[points.length - 1];
    // Drop duplicate vertices: they add nothing and make the segment walk longer.
    if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
    points.push(point);
  }
  return points.length >= 2 ? points : null;
}

/**
 * Cumulative distance in km at each vertex, plus the total.
 * `cumulative[i]` is the distance from vertex 0 to vertex i.
 */
function measureLine(coordinates) {
  const points = toLineCoordinates(coordinates);
  if (!points) return { points: null, cumulative: [], totalKm: 0 };
  const cumulative = [0];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineKm(points[i - 1], points[i]);
    cumulative.push(total);
  }
  return { points, cumulative, totalKm: total };
}

/**
 * The straight-line "route" used when no real road geometry is available.
 *
 * Without this, a ride created before the feature existed (or with no Mapbox
 * token) would have no geometry and could never be matched, so the whole
 * feature would look broken for exactly the existing offers it is meant to
 * improve. Six points between the endpoints give the segment walk a sane
 * resolution, and the honest distance is still reported as the great-circle one.
 */
function straightLine(coordinates, samples = 5) {
  const from = toCoordinate(coordinates?.[0] ?? coordinates?.from);
  const to = toCoordinate(coordinates?.[coordinates.length - 1] ?? coordinates?.to);
  if (!from || !to) return null;
  // Both ends the same point would produce a zero-length "road", which is worse
  // than no road: it would let a ride be matched to anywhere, since a point is
  // within tolerance of every rider who happens to be near it.
  if (from[0] === to[0] && from[1] === to[1]) return null;
  const steps = Math.max(1, Math.min(24, Number(samples) || 5));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const ratio = i / steps;
    points.push([
      from[0] + (to[0] - from[0]) * ratio,
      from[1] + (to[1] - from[1]) * ratio
    ]);
  }
  return points;
}

/* ------------------------------------------------------- the core question */

/**
 * Where on the route does `point` sit?
 *
 * This is the single most important function in the feature: it answers "is this
 * rider's pickup on this ride?" and, if so, "how far along?", in one pass.
 *
 * @returns {{
 *   distanceKm: number, alongKm: number, fraction: number,
 *   point: [number, number], segmentIndex: number
 * } | null} null when there is no usable route.
 */
function nearestOnRoute(point, coordinates) {
  const target = toCoordinate(point);
  const { points, cumulative, totalKm } = measureLine(coordinates);
  if (!target || !points) return null;

  let best = null;
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    const distanceKm = distanceToSegmentKm(target, start, end);
    if (best && distanceKm >= best.distanceKm) continue;
    // Re-project to find WHERE on this segment the point lies, so `alongKm` is
    // continuous rather than snapping to whichever vertex happens to be closer.
    const segmentKm = cumulative[i + 1] - cumulative[i];
    const alongKm = cumulative[i] + distanceAlongSegmentKm(target, start, end, segmentKm);
    best = {
      distanceKm,
      alongKm: Math.max(0, Math.min(totalKm, alongKm)),
      segmentIndex: i,
      totalKm
    };
  }
  if (!best) return null;
  return {
    distanceKm: best.distanceKm,
    alongKm: best.alongKm,
    fraction: totalKm > 0 ? best.alongKm / totalKm : 0,
    totalKm,
    segmentIndex: best.segmentIndex,
    point: interpolate(points, best.segmentIndex, best.alongKm, cumulative)
  };
}

/**
 * How far along segment a..b the perpendicular foot of `point` sits.
 *
 * Uses the same local projection as distanceToSegmentKm so the two agree: the
 * returned fraction places the point where the perpendicular actually lands,
 * which is what makes `alongKm` continuous across vertices.
 */
function distanceAlongSegmentKm(point, a, b, segmentKm) {
  if (!(segmentKm > 0)) return 0;
  const p = project(point, a[1]);
  const s = project(a, a[1]);
  const e = project(b, a[1]);
  const dx = e[0] - s[0];
  const dy = e[1] - s[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return 0;
  let t = ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return t * segmentKm;
}

/** The coordinate sitting `alongKm` into the route. */
function interpolate(points, segmentIndex, alongKm, cumulative) {
  const start = points[segmentIndex];
  const end = points[segmentIndex + 1] || start;
  const segmentKm = (cumulative[segmentIndex + 1] ?? alongKm) - cumulative[segmentIndex];
  if (!(segmentKm > 0)) return [...start];
  const t = Math.max(0, Math.min(1, (alongKm - cumulative[segmentIndex]) / segmentKm));
  return [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
}

/** The coordinate at a given fraction (0..1) of the route. */
function pointAtFraction(coordinates, fraction) {
  const { points, cumulative, totalKm } = measureLine(coordinates);
  if (!points) return null;
  if (!(totalKm > 0)) return [...points[0]];
  return interpolate(points, nearestVertexIndex(cumulative, totalKm * Math.max(0, Math.min(1, fraction))),
    totalKm * Math.max(0, Math.min(1, fraction)), cumulative);
}

function nearestVertexIndex(cumulative, target) {
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < cumulative.length; i += 1) {
    const distance = Math.abs(cumulative[i] - target);
    if (distance < best) { best = distance; index = i; }
  }
  return index;
}

/** The coordinate at an absolute distance-along-the-route. */
function pointAtKm(coordinates, alongKm) {
  const { points, cumulative, totalKm } = measureLine(coordinates);
  if (!points) return null;
  return interpolate(points, nearestVertexIndex(cumulative, alongKm), Math.max(0, Math.min(totalKm, alongKm)), cumulative);
}

/**
 * The part of the route between two distances along it.
 *
 * This is what the map draws for a partial ride: the rider sees THEIR leg
 * highlighted, not the driver's whole journey.
 */
function sliceBetween(coordinates, fromKm, toKm) {
  const { points, cumulative, totalKm } = measureLine(coordinates);
  if (!points) return null;
  const start = Math.max(0, Math.min(totalKm, num(fromKm, 0)));
  const end = Math.max(0, Math.min(totalKm, num(toKm, totalKm)));
  if (end <= start) return [pointAtKm(coordinates, start)].filter(Boolean);
  const first = pointAtKm(coordinates, start);
  const last = pointAtKm(coordinates, end);
  const middle = points.filter((point, index) => {
    const at = cumulative[index];
    return at > start && at < end;
  });
  return [first, ...middle, last].filter(Boolean);
}

/** The bounding box, handy for fitting a map and for quick containment tests. */
function boundingBox(coordinates) {
  const points = toLineCoordinates(coordinates);
  if (!points) return null;
  const west = Math.min(...points.map(point => point[0]));
  const east = Math.max(...points.map(point => point[0]));
  const south = Math.min(...points.map(point => point[1]));
  const north = Math.max(...points.map(point => point[1]));
  return { west, south, east, north, centre: [(west + east) / 2, (south + north) / 2] };
}

/* ------------------------------------------------------------- gazetteer */

/**
 * A built-in gazetteer of Indian cities.
 *
 * WHY THIS EXISTS: it is what makes the feature work on a fresh clone with an
 * empty .env. "Rajkot" still resolves, the route is still built, the rider
 * still matches and the price is still calculated by distance — the only thing
 * missing is real road geometry, which is replaced by a straight line and
 * clearly reported as `provider: "estimate"`. With a Mapbox token present, the
 * same code paths use the real road shape.
 *
 * It also does the reverse job: working out which towns a real road passes
 * through ("via Rajkot") by testing each gazetteer entry against the actual
 * geometry, which is more reliable than Mapbox's own `steps` for spotting a
 * major town the highway merely passes rather than turns at.
 */
const CITIES = [
  // ---- Gujarat -----------------------------------------------------------
  ['ahmedabad', 'Ahmedabad', 72.5714, 23.0225], ['surat', 'Surat', 72.8311, 21.1702],
  ['vadodara', 'Vadodara', 73.1812, 22.3072], ['rajkot', 'Rajkot', 70.8022, 22.3039],
  ['junagadh', 'Junagadh', 70.4579, 21.5222], ['jamnagar', 'Jamnagar', 70.0577, 22.4707],
  ['bhavnagar', 'Bhavnagar', 71.9725, 21.7645], ['gandhinagar', 'Gandhinagar', 72.6369, 23.2156],
  ['anand', 'Anand', 72.9289, 22.5645], ['bharuch', 'Bharuch', 72.9897, 21.7051],
  ['navsari', 'Navsari', 72.9467, 20.9467], ['mehsana', 'Mehsana', 72.3958, 23.5880],
  ['morbi', 'Morbi', 70.8378, 22.8173], ['bhuj', 'Bhuj', 69.6694, 23.2420],
  ['surendranagar', 'Surendranagar', 71.6500, 22.7272], ['amreli', 'Amreli', 71.4699, 21.6012],
  ['borsad', 'Borsad', 72.6381, 22.4167], ['dahod', 'Dahod', 75.2557, 22.8367],
  ['narmadapuram', 'Narmadapuram', 72.9514, 22.9881], ['palanpur', 'Palanpur', 72.4350, 24.1714],
  ['dehgam', 'Dehgam', 72.5200, 23.8300], ['dholka', 'Dholka', 72.4422, 22.7272],
  ['kheda', 'Kheda', 72.6167, 22.7500], ['botad', 'Botad', 71.6667, 22.1667],
  ['gondal', 'Gondal', 70.8000, 21.9667], ['jetpur', 'Jetpur', 70.6167, 21.7500],
  ['dhoraji', 'Dhoraji', 70.2833, 21.7333], ['kunkavav', 'Kunkavav', 70.9833, 21.8333],
  ['wankaner', 'Wankaner', 70.9667, 22.6167], ['lodhika', 'Lodhika', 72.3833, 22.5333],
  ['sanand', 'Sanand', 72.3788, 22.9919], ['asindal', 'Asindal', 72.6190, 23.0552],
  ['bagasra', 'Bagasra', 71.6333, 21.4833], ['jasdan', 'Jasdan', 71.2167, 22.0333],
  ['keshod', 'Keshod', 70.2500, 21.3000], ['chorvadla', 'Chorvadla', 70.4000, 21.3333],
  ['manavadar', 'Manavadar', 71.1833, 21.3667], ['talala', 'Talala', 70.5333, 21.4833],
  ['sutrapada', 'Sutrapada', 70.7000, 21.1667], ['una', 'Una', 70.7333, 20.8333],
  ['veraval', 'Veraval', 70.3667, 20.8167], ['kodinar', 'Kodinar', 70.2000, 20.8333],
  ['somnath', 'Somnath', 70.4000, 20.7667], ['mangrol', 'Mangrol', 70.9833, 20.5333],
  ['mandvi', 'Mandvi', 69.3667, 22.8333], ['valsad', 'Valsad', 72.9333, 20.6000],
  ['palsana', 'Palsana', 72.7667, 20.7667], ['bardoli', 'Bardoli', 73.1167, 21.1167],
  ['kim', 'Kim', 73.0333, 21.2000], ['olpad', 'Olpad', 72.5167, 21.0167],
  ['savarkundla', 'Savarkundla', 71.9667, 21.3333],
  ['bagodhar', 'Bagodhar', 73.0833, 20.8833],
  ['sarkhej', 'Sarkhej', 72.5002, 22.9836], ['itola', 'Itola', 72.6167, 22.5500],
  ['chandkheda', 'Chandkheda', 72.4500, 23.2500], ['khoraj', 'Khoraj', 72.7500, 21.3000],
  ['kadodara', 'Kadodara', 73.0167, 21.1667],
  ['babra', 'Babra', 71.3000, 22.0333], ['wadhwan', 'Wadhwan', 71.6796, 22.7104],
  ['tangadh', 'Tangadh', 71.0667, 21.7667], ['bagodra', 'Bagodra', 72.2000, 22.3167],
  // ---- Rajasthan ---------------------------------------------------------
  ['jaipur', 'Jaipur', 75.7873, 26.9124], ['jodhpur', 'Jodhpur', 73.0243, 26.2389],
  ['udaipur', 'Udaipur', 73.7125, 24.5854], ['kota', 'Kota', 75.8648, 25.2138],
  ['ajmer', 'Ajmer', 74.6396, 26.4499], ['bikaner', 'Bikaner', 73.3119, 28.0229],
  ['jaisalmer', 'Jaisalmer', 70.9089, 26.9157], ['mount abu', 'Mount Abu', 72.7167, 24.5925],
  ['pushkar', 'Pushkar', 74.9649, 26.4894], ['sawai madhopur', 'Sawai Madhopur', 76.3725, 26.0173],
  ['sikar', 'Sikar', 75.1396, 27.6094], ['pali', 'Pali', 73.3234, 25.7711],
  ['bhilwara', 'Bhilwara', 74.6313, 25.3407], ['barmer', 'Barmer', 71.1167, 25.7333],
  ['jhalawar', 'Jhalawar', 75.1094, 24.5931], ['nashik', 'Nashik', 73.7898, 19.9980],
  // ---- Maharashtra / Goa -------------------------------------------------
  ['mumbai', 'Mumbai', 72.8777, 19.0760], ['pune', 'Pune', 73.8567, 18.5204],
  ['nagpur', 'Nagpur', 79.0882, 21.1458], ['aurangabad', 'Aurangabad', 75.3433, 19.8762],
  ['solapur', 'Solapur', 75.9067, 17.6599], ['kolhapur', 'Kolhapur', 74.2433, 16.7050],
  ['amravati', 'Amravati', 77.7506, 20.9374], ['goa', 'Goa', 73.8315, 15.2993],
  ['panaji', 'Panaji', 73.8337, 15.4909], ['vasai', 'Vasai', 72.8397, 19.3919],
  ['thane', 'Thane', 72.9781, 19.2183], ['nashik road', 'Nashik Road', 73.2000, 20.0000],
  // ---- Madhya Pradesh / Chhattisgarh -------------------------------------
  ['indore', 'Indore', 75.8577, 22.7196], ['bhopal', 'Bhopal', 77.4126, 23.2599],
  ['gwalior', 'Gwalior', 78.1822, 26.2155], ['jabalpur', 'Jabalpur', 79.9864, 23.2090],
  ['raipur', 'Raipur', 81.6296, 21.2514], ['bilaspur', 'Bilaspur', 82.1545, 22.0797],
  // ---- Uttar Pradesh / Bihar / Uttarakhand / Himachal / Haryana ---------
  ['delhi', 'Delhi', 77.1025, 28.7041], ['agra', 'Agra', 78.0081, 27.1767],
  ['lucknow', 'Lucknow', 80.9462, 26.8467], ['kanpur', 'Kanpur', 80.3319, 26.4499],
  ['varanasi', 'Varanasi', 82.9739, 25.3176], ['patna', 'Patna', 85.1376, 25.5941],
  ['dehradun', 'Dehradun', 78.0322, 30.3165], ['haridwar', 'Haridwar', 78.1677, 29.9457],
  ['shimla', 'Shimla', 77.1734, 31.1048], ['chandigarh', 'Chandigarh', 76.7794, 30.7333],
  ['gurgaon', 'Gurgaon', 77.0266, 28.4595], ['noida', 'Noida', 77.3910, 28.5355],
  // ---- Gujarat + Maharashtra highway towns (NH-27 / NH-8) ---------------
  ['neemuch', 'Neemuch', 74.9333, 24.4667], ['ratlam', 'Ratlam', 75.0333, 23.3333],
  ['barwani', 'Barwani', 74.6833, 22.0333], ['kharagpur', 'Kharagpur', 75.1167, 21.8333],
  ['sendhwa', 'Sendhwa', 76.3667, 21.6833], ['khanapur', 'Khanapur', 76.3500, 21.2500],
  ['sangli', 'Sangli', 74.5815, 16.8524], ['miraj', 'Miraj', 74.8333, 16.9833],
  ['ahmednagar', 'Ahmednagar', 74.7480, 19.0948], ['shirpur', 'Shirpur', 74.3000, 19.7500],
  ['dhule', 'Dhule', 74.9000, 20.9000], ['jalgaon', 'Jalgaon', 75.5626, 21.0077],
  ['bhusawal', 'Bhusawal', 75.7500, 21.0333], ['surat city', 'Surat City', 72.8000, 21.1500],
  ['dindori', 'Dindori', 74.2167, 22.9333], ['amargadh', 'Amargadh', 74.5167, 23.6000],
  ['bhanpura', 'Bhanpura', 75.1167, 24.1500], ['kotda sangani', 'Kotda Sangani', 70.7667, 21.4833],
  ['vaviyasar', 'Vaviyasar', 70.8167, 21.6500], ['kodur', 'Kodur', 70.7500, 21.7000],
  ['dhrol', 'Dhrol', 70.6000, 22.1667], ['kalavad', 'Kalavad', 70.5500, 22.2000],
  ['sardar gadh', 'Sardar Gadh', 70.8833, 22.4833], ['bagasara', 'Bagasara', 70.5000, 22.1833],
  ['jodiya', 'Jodiya', 70.5000, 22.7833], ['sindhpur', 'Sindhpur', 70.5333, 23.2500],
  ['kharaghoda', 'Kharaghoda', 70.4000, 23.1500], ['dehgam junction', 'Dehgam', 72.5200, 23.8300]
];

/** Lower-cased name -> [lng, lat], for a fast local lookup. */
const GAZETTEER = (() => {
  const map = new Map();
  for (const [key, name, lng, lat] of CITIES) {
    map.set(key, { name, coordinate: [lng, lat] });
  }
  return map;
})();

/** Spelled-out names that should also resolve, e.g. "Ahmedabad City". */
const ALIASES = new Map([
  ['amdavad', 'ahmedabad'],
  ['ahmedabad city', 'ahmedabad'],
  ['surat city', 'surat'],
  ['rajkot city', 'rajkot'],
  ['junagadh city', 'junagadh'],
  ['bhavnagar city', 'bhavnagar'],
  ['bombay', 'mumbai'],
  ['poona', 'pune'],
  ['madras', 'chennai'],
  ['bangalore', 'bengaluru'],
  ['banaras', 'varanasi'],
  ['new delhi', 'delhi'],
  ['narmada', 'narmadapuram'],
  ['bharuch city', 'bharuch'],
  ['kutch', 'bhuj'],
  ['mount abu', 'mount abu']
]);

/** Bounding box used to bias an ambiguous Mapbox search toward Gujarat. */
const GAZETTEER_BOUNDS = { west: 68.1, south: 20.1, east: 74.5, north: 24.9 };

function normalisePlace(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolves a place name against the built-in gazetteer, or null. */
function gazetteerLookup(value) {
  const key = normalisePlace(value);
  if (!key) return null;
  const direct = GAZETTEER.get(key);
  if (direct) return { name: direct.name, coordinate: [...direct.coordinate], source: 'gazetteer' };
  const aliased = ALIASES.get(key);
  if (aliased && GAZETTEER.has(aliased)) {
    const hit = GAZETTEER.get(aliased);
    return { name: hit.name, coordinate: [...hit.coordinate], source: 'gazetteer' };
  }
  // "Junagadh, Gujarat" or "Rajkot Gujarat" still resolves on the first token.
  for (const token of key.split(' ')) {
    if (token.length < 3) continue;
    const hit = GAZETTEER.get(token) || (ALIASES.has(token) && GAZETTEER.get(ALIASES.get(token)));
    if (hit) return { name: hit.name, coordinate: [...hit.coordinate], source: 'gazetteer' };
  }
  return null;
}

/**
 * The gazetteer town nearest a coordinate, within a radius, or null.
 *
 * This is how a dropped pin gets a name when no geocoding key is configured: a
 * rider who pinned a spot 12 km short of Rajkot is told "near Rajkot" rather
 * than "Pinned location", which is the difference between a card they can act on
 * and one they cannot.
 *
 * The radius is not a detail. Beyond it the answer stops being true - "near
 * Ahmedabad" for a pin out by Borsad is worse than no name at all, because the
 * rider would board expecting the wrong town. So this returns null rather than
 * the farthest-away entry it could find, and the caller falls back to a generic
 * label. A wrong name is the one failure a distance-based feature cannot make.
 */
function nearestPlace(coordinate, radiusKm = 25) {
  const point = toCoordinate(coordinate);
  if (!point || !(radiusKm > 0)) return null;
  let best = null;
  for (const [, name, lng, lat] of CITIES) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const distanceKm = haversineKm(point, [lng, lat]);
    if (distanceKm > radiusKm) continue;
    if (!best || distanceKm < best.distanceKm) best = { name, coordinate: [lng, lat], distanceKm };
  }
  return best;
}

/**
 * Which known towns does this route pass through?
 *
 * Two stages, and the split is the whole point of this function.
 *
 * A coarse walk along the geometry is used only to decide which towns are
 * WORTH measuring - it is fast, but it cannot answer the question, because a
 * town can sit 6 km from the road and 7 km from every sample point, and would
 * then be silently dropped. Every town that walk flags is then measured exactly
 * with `nearestOnRoute`, which is the same code that decides where a rider
 * boards. So the towns reported here, the distance shown beside them, and the
 * place the rider is told to board all come out of one piece of geometry.
 *
 * `exact: true` skips the sampling guess and measures every town in the
 * corridor. That costs about 80 ms on a 3000-vertex road, which is fine when a
 * route is computed once and stored, and not fine per search - hence the flag.
 *
 * @param {number} [options.toleranceKm] how far off the road still counts
 * @param {number} [options.limit]       most towns to return
 * @param {string[]} [options.exclude]   names to leave out (the two end towns)
 * @param {boolean} [options.exact]      measure every corridor town, not a sample
 */
function viaPointsAlongRoute(coordinates, { toleranceKm = 6, limit = 6, exclude = [], exact = false } = {}) {
  const { points, cumulative, totalKm } = measureLine(coordinates);
  if (!points) return [];
  const skip = new Set(exclude.map(name => normalisePlace(name)).filter(Boolean));
  const box = boundingBox(points);
  if (!box) return [];
  // Nothing outside the corridor can possibly be within tolerance, so the
  // gazetteer is narrowed before any real work happens.
  const pad = Math.max(0, num(toleranceKm, 6));
  const candidates = [...GAZETTEER.values()].filter(city => {
    if (skip.has(normalisePlace(city.name))) return false;
    const [lng, lat] = city.coordinate;
    return lng >= box.west - pad && lng <= box.east + pad
      && lat >= box.south - pad && lat <= box.north + pad;
  });
  if (!candidates.length) return [];

  const record = (city, hit) => ({
    name: city.name,
    coordinate: [...city.coordinate],
    // The closest point ON THE ROAD, not the town centre. Reporting where the
    // road actually comes closest is what makes the "74 km" figure meaningful.
    alongKm: Math.round(hit.alongKm * 10) / 10,
    distanceKm: Math.round(hit.distanceKm * 10) / 10,
    fraction: totalKm > 0 ? hit.alongKm / totalKm : 0
  });

  if (exact) {
    const hits = [];
    for (const city of candidates) {
      const hit = nearestOnRoute(city.coordinate, points);
      if (hit && hit.distanceKm <= toleranceKm) hits.push(record(city, hit));
    }
    return hits.sort((a, b) => a.alongKm - b.alongKm).slice(0, limit);
  }

  // Stage one: a coarse walk to shortlist. Spacing is held at or below the
  // tolerance so a town the road genuinely passes cannot fall between two
  // samples by more than the tolerance itself.
  const shortlisted = new Set();
  const spacing = Math.max(1, Math.min(10, num(toleranceKm, 6)));
  const steps = Math.max(6, Math.min(400, Math.ceil(totalKm / spacing) + 6));
  for (let i = 0; i <= steps; i += 1) {
    const alongKm = (totalKm * i) / steps;
    const probe = interpolate(points, nearestVertexIndex(cumulative, alongKm), alongKm, cumulative);
    // A sample cannot be further than the spacing from a town the road passes
    // within tolerance of, so the shortlist test is widened to cover the miss.
    const reach = toleranceKm + spacing;
    for (const city of candidates) {
      if (shortlisted.has(city.name)) continue;
      if (haversineKm(probe, city.coordinate) <= reach) shortlisted.add(city.name);
    }
  }
  // Stage two: measure the shortlist for real.
  const hits = [];
  for (const city of candidates) {
    if (!shortlisted.has(city.name)) continue;
    const hit = nearestOnRoute(city.coordinate, points);
    if (hit && hit.distanceKm <= toleranceKm) hits.push(record(city, hit));
  }
  return hits.sort((a, b) => a.alongKm - b.alongKm).slice(0, limit);
}

/**
 * The towns a rider passes BETWEEN two points on one road.
 *
 * This is the "how many cities in between" number, and it is deliberately not
 * the same thing as the whole route's `via` list. A rider boarding at Rajkot on a
 * Junagadh-Ahmedabad road does not care that Talala is 91 km back the way they
 * came; they care what is ahead of them. So this is computed on the rider's own
 * leg, and the two ends are excluded because standing in the town you are
 * leaving is not "passing through" it.
 *
 * Returns the towns with their distance from the BOARDING point, which is the
 * number a rider reads ("Sanand, 74 km"), plus the count.
 */
function townsBetween(coordinates, fromKm, toKm, { toleranceKm = 6, limit = 8, exclude = [] } = {}) {
  const start = Math.max(0, num(fromKm, 0));
  const end = Math.max(start, num(toKm, 0));
  const slice = sliceBetween(coordinates, start, end);
  const span = end - start;
  if (span <= 0) return { count: 0, towns: [], spanKm: 0 };
  const found = viaPointsAlongRoute(slice, { toleranceKm, limit: limit + 4, exclude });
  const towns = found
    .map(entry => ({
      name: entry.name,
      coordinate: entry.coordinate,
      // `alongKm` here is measured along the SLICE, so it is already the distance
      // from where the rider boards. That is the number a rider wants, and it is
      // the same frame as `span` below - which is why the two can be compared.
      fromBoardKm: Math.round(entry.alongKm * 10) / 10
    }))
    // A town within half a kilometre of either end is where the rider is
    // standing, not somewhere they pass through. The far end also has to leave
    // room for the destination itself, which sits at exactly `span`.
    .filter(entry => entry.fromBoardKm > 0.5 && entry.fromBoardKm < span - 0.5)
    .slice(0, limit);
  return {
    count: towns.length,
    towns,
    spanKm: Math.round(span * 10) / 10
  };
}

/**
 * Distance checkpoints along a line, every `everyKm`, the way a navigation app
 * marks progress.
 *
 * The first and last are never inside the interval's own rounding: a marker at
 * "0 km" is noise, and one at "213 km" on a 213.8 km leg is noise too. So the
 * markers run strictly between the two ends.
 */
function distanceCheckpoints(coordinates, { everyKm = 50, offsetKm = 0, totalKm = null } = {}) {
  const measured = measureLine(coordinates);
  if (!measured) return [];
  const { points, cumulative } = measured;
  const total = totalKm === null ? measured.totalKm : num(totalKm, measured.totalKm);
  if (!(everyKm > 0) || !(total > 0) || points.length < 2) return [];
  const out = [];
  // Walk the line marking every whole multiple of the interval.
  const first = Math.ceil(((offsetKm || 0) + 1e-6) / everyKm) * everyKm;
  for (let mark = first; mark < total - 1e-6; mark += everyKm) {
    const remaining = mark - (offsetKm || 0);
    const index = nearestVertexIndex(cumulative, remaining);
    out.push({
      km: Math.round(mark * 10) / 10,
      fromBoardKm: Math.round(remaining * 10) / 10,
      coordinate: interpolate(points, index, remaining, cumulative)
    });
  }
  return out;
}

module.exports = {
  EARTH_RADIUS_KM,
  DEFAULT_TOLERANCE_KM,
  MIN_TRAVEL_KM,
  MAX_HEADING_DIFFERENCE_DEG,
  toCoordinate,
  isCoordinate,
  haversineKm,
  distanceToSegmentKm,
  bearingDeg,
  headingDifferenceDeg,
  toLineCoordinates,
  measureLine,
  straightLine,
  nearestOnRoute,
  pointAtFraction,
  pointAtKm,
  sliceBetween,
  boundingBox,
  townsBetween,
  distanceCheckpoints,
  gazetteerLookup,
  nearestPlace,
  viaPointsAlongRoute,
  GAZETTEER_BOUNDS,
  CITIES
};

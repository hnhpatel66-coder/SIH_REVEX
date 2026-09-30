#!/usr/bin/env node
/**
 * SMART ROUTE  (tests/smart-route.test.js)
 *
 * A rider in Rajkot searching for "Rajkot to Ahmedabad" must find an owner's
 * "Junagadh to Ahmedabad" offer, because the road between those two really does
 * run through Rajkot, and must pay for the part of it they travel rather than
 * for all 315 km of it. That is the entire feature, and it is easy to break in
 * ways no other test would notice, so it is pinned from both ends:
 *
 *   - the GEOMETRY (geo.js): distance to a road, distance along a road, bearings.
 *     A bug here silently moves boarding points.
 *   - the POLICY (smartRoute.js): who may join, how far off the road counts as
 *     on it, and which way the vehicle is going.
 *   - the MONEY (ridePricing.js): the fare is the same arithmetic the full-route
 *     fare already used, prorated by distance.
 *   - the WIRING: the endpoints exist, the secret token never leaves the server,
 *     the browser module is a real module, and the env file documents the keys.
 *
 * Everything here runs OFFLINE. The road geometry in the fixtures is a
 * hand-written polyline standing in for the real one, and no assertion depends
 * on a live Mapbox or OSRM response - those are verified separately by
 * scripts/verify-live.js, where a network failure cannot be mistaken for a
 * passing test.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./harness');

const ROOT = path.join(__dirname, '..');
const geo = require('../backend/utils/geo');
const smartRoute = require('../backend/utils/smartRoute');
const ridePricing = require('../backend/utils/ridePricing');
const mapbox = require('../backend/utils/mapbox');

const t = createSuite('smart route');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

/* ------------------------------------------------------------- fixtures */

/**
 * A stand-in for the real Junagadh to Ahmedabad road, as the driver would take
 * it: north-east to Jetpur and Gondal, north to Rajkot, then east past Gadhada
 * and Borsad to Sanand and Ahmedabad.
 *
 * The shape is the point. The direct Junagadh-Ahmedabad line passes ~47 km
 * WEST of Rajkot, so any approach that matches rides by name or by straight
 * line cannot find this ride from Rajkot at all.
 */
const ROAD_WAYPOINTS = [
  [70.4579, 21.5222], // Junagadh
  [70.52, 21.63],
  [70.6167, 21.75], // Jetpur
  [70.71, 21.86],
  [70.8, 21.9667], // Gondal
  [70.76, 22.09],
  [70.73, 22.20],
  // The highway bypasses Rajkot rather than driving into it, so the polyline
  // passes a few kilometres from the town centre. That offset is not decoration:
  // it is exactly the situation the tolerance exists for, and a fixture that ran
  // straight through the centre would never test it.
  [70.77, 22.24],
  [70.775, 22.33],
  [71.05, 22.38],
  [71.45, 22.42],
  [71.90, 22.38], // Gadhada
  [72.30, 22.55],
  [72.6381, 22.4167], // Borsad
  [72.47, 22.79],
  [72.4667, 22.9833], // Sanand
  [72.50, 23.01],
  [72.5714, 23.0225] // Ahmedabad
];

/** Linear densification, so the fixture behaves like a routed polyline. */
function densify(waypoints, perLeg = 12) {
  const points = [];
  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const [x1, y1] = waypoints[i];
    const [x2, y2] = waypoints[i + 1];
    for (let step = 0; step < perLeg; step += 1) {
      const k = step / perLeg;
      points.push([x1 + (x2 - x1) * k, y1 + (y2 - y1) * k]);
    }
  }
  points.push(waypoints[waypoints.length - 1]);
  return points;
}

const ROAD = densify(ROAD_WAYPOINTS);
const JUNAGADH = [70.4579, 21.5222];
const AHMEDABAD = [72.5714, 23.0225];
const RAJKOT = [70.8022, 22.3039];
const SANAND = [72.4667, 22.9833];

/** An owner's offer, as it is stored once the route has been computed. */
const RIDE = {
  _id: '507f1f77bcf86cd799439011',
  from: 'Junagadh',
  to: 'Ahmedabad',
  vehicle: 'Toyota Innova',
  vehicleType: 'Car',
  price: 800,
  additionalCharges: 50,
  discountPercent: 0,
  seatsTotal: 4,
  status: 'approved',
  routeOrigin: JUNAGADH,
  routeDestination: AHMEDABAD,
  routeGeometry: ROAD,
  routeDistanceKm: 0,
  routeDurationMin: 0,
  routeVia: [
    { name: 'Rajkot', coordinate: RAJKOT, alongKm: 0 },
    { name: 'Borsad', coordinate: [72.6544, 22.6003], alongKm: 0 }
  ],
  routeProvider: 'mapbox',
  routeComputedAt: new Date('2026-01-01T00:00:00Z')
};

const OPTIONS = { toleranceKm: 10, midRouteKm: 5, minTravelKm: 5, minMatchFraction: 0.03, maxHeadingDifferenceDeg: 120 };

/* --------------------------------------------------------------- geometry */

t.describe('distance and bearings', () => {
  // One degree of latitude is very close to 111 km anywhere on earth; if this
  // drifts, every tolerance in the feature is quietly wrong. Measured away from
  // 0,0 because 0,0 is deliberately treated as "no data" (null island).
  const oneDegree = geo.haversineKm([70, 21], [70, 22]);
  t.ok(oneDegree > 110.5 && oneDegree < 111.5, `one degree of latitude is about 111 km (${oneDegree.toFixed(2)})`);

  t.equal(geo.haversineKm(JUNAGADH, JUNAGADH), 0, 'a point is zero km from itself');
  t.ok(geo.haversineKm([70, 21], [71, 21]) > 100, 'one degree of longitude at 21°N is over 100 km');
  t.equal(geo.haversineKm(JUNAGADH, [0, 0]), 0, 'a null-island coordinate counts as no data, so no distance is invented');

  const north = geo.bearingDeg([70, 21], [70, 22]);
  t.ok(Math.abs(north - 0) < 1, 'due north reads as a bearing of 0');
  const east = geo.bearingDeg([70, 21], [71, 21]);
  t.ok(Math.abs(east - 90) < 1, 'due east reads as a bearing of 90');
  t.equal(geo.headingDifferenceDeg(10, 100), 90, 'a right angle is a 90 degree difference');
  t.equal(geo.headingDifferenceDeg(350, 10), 20, 'the difference wraps around north instead of reading 340');
  t.equal(geo.headingDifferenceDeg(0, 0), 0, 'the same heading is no difference');
});

t.describe('the gazetteer resolves the towns this feature is about', () => {
  for (const name of ['Junagadh', 'Rajkot', 'Ahmedabad', 'Gondal', 'Sanand', 'Borsad', 'Jetpur']) {
    const hit = geo.gazetteerLookup(name);
    t.ok(hit && Array.isArray(hit.coordinate), `${name} resolves to a coordinate`);
  }
  t.equal(geo.gazetteerLookup('rajkot').name, 'Rajkot', 'the lookup ignores case');
  t.equal(geo.gazetteerLookup('  RAJKOT  ').name, 'Rajkot', 'the lookup ignores stray whitespace');
  t.equal(geo.gazetteerLookup('Rajkot, Gujarat').name, 'Rajkot', 'the lookup tolerates a trailing region');
  t.equal(geo.gazetteerLookup('Atlantis'), null, 'a place that is not in the gazetteer is not invented');
  t.equal(geo.gazetteerLookup(''), null, 'an empty name resolves to nothing');
  t.equal(geo.gazetteerLookup(null), null, 'a missing name resolves to nothing');
});

t.describe('a coordinate pair is normalised, a bad one is refused', () => {
  t.deepEqual(geo.toCoordinate([70.8, 22.3]), [70.8, 22.3], 'a [lng,lat] array');
  t.equal(geo.toCoordinate([0, 0]), null, 'null island is refused as "no data", not as a place off West Africa');
  t.deepEqual(geo.toCoordinate([0, 21]), [0, 21], 'but a real coordinate on the prime meridian is fine');
  t.deepEqual(geo.toCoordinate(['70.8', '22.3']), [70.8, 22.3], 'numeric strings are accepted, because that is what arrives in a query string');
  t.equal(geo.toCoordinate([200, 22.3]), null, 'a longitude outside the world is refused');
  t.equal(geo.toCoordinate([70.8, 91]), null, 'a latitude outside the world is refused');
  t.equal(geo.toCoordinate([70.8]), null, 'half a coordinate is refused');
  t.equal(geo.toCoordinate(['Junagadh', null]), null, 'a place name is not a coordinate');
  t.equal(geo.toCoordinate(null), null, 'nothing is not a coordinate');
  t.ok(geo.isCoordinate([70.8, 22.3]), 'isCoordinate agrees');
  t.ok(!geo.isCoordinate('Rajkot'), 'isCoordinate refuses a name');

  // The object and GeoJSON forms are unwrapped by the caller, so they are
  // pinned here at the call site rather than on toCoordinate itself.
  const readPoint = { name: 'Rajkot', lng: 70.8022, lat: 22.3039 };
  t.deepEqual(geo.toCoordinate([readPoint.lng, readPoint.lat]), RAJKOT, 'a caller can hand a {lng,lat} point straight through');
  t.deepEqual(geo.toCoordinate([70.8, 22.3]), geo.toCoordinate(JSON.parse(JSON.stringify([70.8, 22.3]))), 'and it survives a JSON round trip, which is what a query string goes through');
});

t.describe('geometry arrives in every shape a mapping API can return', () => {
  const pair = ROAD.slice(0, 40);
  t.deepEqual(geo.toLineCoordinates(pair), pair, 'a bare [[lng,lat], ...] array is a line');
  t.deepEqual(geo.toLineCoordinates({ type: 'LineString', coordinates: pair }), pair, 'a LineString geometry');
  t.deepEqual(geo.toLineCoordinates({ type: 'Feature', geometry: { type: 'LineString', coordinates: pair } }), pair, 'a LineString feature');
  t.equal(geo.toLineCoordinates({ type: 'Point', coordinates: JUNAGADH }), null, 'a single point is not a line');
  t.equal(geo.toLineCoordinates([JUNAGADH]), null, 'nor is a one-vertex array');
  t.equal(geo.toLineCoordinates(null), null, 'and nothing is not a line');
  t.equal(geo.toLineCoordinates({ type: 'Polygon', coordinates: [] }), null, 'a polygon is not a line');
  t.equal(geo.toLineCoordinates([[70, 21], [70, 21]]), null, 'two identical vertices are not a line');

  // A road split into several parts is a real case, and picking the wrong part
  // would put a rider's boarding point on a road the driver never drives.
  const long = densify(ROAD_WAYPOINTS.slice(0, 4), 6);
  const short = densify(ROAD_WAYPOINTS.slice(4, 6), 6);
  t.deepEqual(
    geo.toLineCoordinates({ type: 'MultiLineString', coordinates: [short, long] }),
    long,
    'a multi-part line reduces to its longest part'
  );
  t.deepEqual(
    geo.toLineCoordinates({ type: 'GeometryCollection', geometries: [
      { type: 'Point', coordinates: JUNAGADH },
      { type: 'LineString', coordinates: long }
    ] }),
    long,
    'a geometry collection finds the line inside it'
  );
  t.deepEqual(geo.toLineCoordinates([{ type: 'Feature', geometry: { type: 'LineString', coordinates: long } }]), long, 'a feature list');
});

t.describe('measuring a road', () => {
  const measured = geo.measureLine(ROAD);
  t.ok(measured.totalKm > 300 && measured.totalKm < 400, `the fixture road is a plausible length (${measured.totalKm.toFixed(1)} km)`);
  t.equal(measured.points.length, ROAD.length, 'every vertex survives measurement');
  t.equal(measured.cumulative[0], 0, 'the cumulative distance starts at zero');
  t.equal(geo.measureLine([]).totalKm, 0, 'an empty line is zero km');
  t.equal(geo.measureLine(null).totalKm, 0, 'no line is zero km');
  t.equal(geo.measureLine([JUNAGADH]).totalKm, 0, 'a single point is zero km');

  const direct = geo.haversineKm(JUNAGADH, AHMEDABAD);
  t.ok(direct < measured.totalKm - 5, 'the road is longer than the straight line between the same two towns, as a real detour is');

  // The straight-line fallback is the last tier, and it is used only when no
  // road-routing provider is reachable. It still has to be a usable line.
  const fallback = geo.straightLine([JUNAGADH, AHMEDABAD]);
  t.ok(Array.isArray(fallback) && fallback.length >= 2, 'the straight-line fallback is a line');
  t.equal(fallback[0][0], JUNAGADH[0], 'starting at the start');
  t.equal(fallback[fallback.length - 1][0], AHMEDABAD[0], 'and ending at the end');
  t.ok(Math.abs(geo.measureLine(fallback).totalKm - direct) < 1, 'and its length is the great-circle one, not a rounded-up fiction');
  t.equal(geo.straightLine([JUNAGADH]), null, 'a fallback with no destination is no fallback');

  const box = geo.boundingBox(ROAD);
  t.ok(box.west <= RAJKOT[0] && box.east >= RAJKOT[0], 'the bounding box contains Rajkot on the road');
  t.deepEqual(box.centre, [(box.west + box.east) / 2, (box.south + box.north) / 2], 'and reports its centre for fitting a map');
  t.equal(geo.boundingBox(null), null, 'no line has no bounding box');
});

t.describe('walking along a road', () => {
  const total = geo.measureLine(ROAD).totalKm;
  const start = geo.pointAtFraction(ROAD, 0);
  const middle = geo.pointAtFraction(ROAD, 0.5);
  const end = geo.pointAtFraction(ROAD, 1);

  t.deepEqual(start, ROAD[0], 'fraction 0 is the start of the road');
  t.deepEqual(end, ROAD[ROAD.length - 1], 'fraction 1 is the end');
  t.ok(geo.nearestOnRoute(middle, ROAD).distanceKm < 0.01, 'the halfway point is on the road');

  const at = geo.pointAtKm(ROAD, total / 2);
  t.ok(geo.haversineKm(at, middle) < 0.01, 'pointAtKm and pointAtFraction agree at the same place');
  t.deepEqual(geo.pointAtKm(ROAD, -50), start, 'a negative distance clamps to the start');
  t.deepEqual(geo.pointAtKm(ROAD, total * 10), end, 'a distance past the end clamps to the end');

  // The three slices the map draws must tile the road exactly. If they did not,
  // the map would be showing a journey that does not add up.
  const a = geo.sliceBetween(ROAD, 0, total / 3);
  const b = geo.sliceBetween(ROAD, total / 3, total * 2 / 3);
  const c = geo.sliceBetween(ROAD, total * 2 / 3, total);
  t.equal(a[0][0], ROAD[0][0], 'the first slice starts at the start');
  t.ok(Math.abs(geo.haversineKm(a[a.length - 1], b[0])) < 0.01, 'the first slice ends where the second begins');
  t.ok(Math.abs(geo.haversineKm(b[b.length - 1], c[0])) < 0.01, 'and the second where the third begins');
  t.ok(Math.abs(geo.measureLine([...a, ...b.slice(1), ...c.slice(1)]).totalKm - total) < 0.01, 'together they are the whole road, to within floating-point noise');
  t.equal(geo.sliceBetween(ROAD, 5, 5).length, 1, 'a zero-length slice is a single point, not an empty array');
  t.equal(geo.sliceBetween(ROAD, 50, 10).length, 1, 'a reversed slice is a single point rather than a line drawn backwards');
  t.equal(geo.sliceBetween(null, 0, 10), null, 'slicing nothing gives nothing');
});

/* ---------------------------------------------------------- the headline case */

t.describe('a rider point is understood in every shape a caller holds it', () => {
  // This is not a defensive nicety. `readSearchPoint` in the router returns
  // `{ name, coordinate }`, `pointSummary` in this module returns
  // `{ name, coordinate, ... }`, and a query string parses to `{ lng, lat }`. A
  // plan builder that only understood one of those would drop the rider's pickup
  // and answer "this ride has no usable road" about a ride that has one - a
  // failure that only appears once you run the whole stack.
  const shapes = [
    ['a plain name', 'Rajkot'],
    ['a {lng,lat} point from a query string', { name: 'Rajkot', lng: RAJKOT[0], lat: RAJKOT[1] }],
    ['a {name, coordinate} point from another helper', { name: 'Rajkot', coordinate: RAJKOT }],
    ['a bare coordinate pair', RAJKOT]
  ];
  for (const [label, from] of shapes) {
    const plan = smartRoute.buildRoutePlan(RIDE, { from, to: 'Ahmedabad' }, OPTIONS);
    t.equal(plan.ok, true, `${label} is accepted`);
    t.equal(plan.reason, 'on_route', `${label} is matched, not refused`);
    t.equal(plan.mode, 'partial', `${label} boards part-way along`);
    t.ok(plan.riderKm > 150, `${label} produces a real fare for a real distance`);
  }

  // A pin the same way round, since pin mode is the other place a point arrives.
  for (const [label, from] of shapes) {
    const plan = smartRoute.buildRoutePlan(RIDE, { from, mode: 'pin' }, OPTIONS);
    t.equal(plan.ok, true, `${label} works as a pin too`);
    t.equal(plan.mode, 'pin', `${label} is treated as a pin`);
  }
});

t.describe('a pin is named without ever being moved', () => {
  // The single most dangerous thing this feature could do: quietly replace a
  // rider's pin with the town name still sitting in the search box. The pin is
  // the rider's decision; the text is a leftover from before they opened the map.
  const source = read('backend/routes/rides.js');
  t.match(source, /const label = await mapbox\.reverseGeocode\(coordinate\);/, 'a pinned end is labelled by reverse geocoding');
  t.match(source, /name: label\.name \|\| 'Pinned point',[\s\S]{0,80}coordinate,/, 'and the coordinate is returned untouched beside the name');
  t.ok(!/geocode\(String\((?:value\.name|value) \|\| ''\), \{ lng, lat \}\)/.test(source), 'the pin is never round-tripped through forward geocoding, which would re-place it at the name');
  t.match(source, /pinned: \{ from: Boolean\(from\.pinned\), to: Boolean\(to\.pinned\) \}/, 'and the response says which end the rider pinned, so the card can explain itself');

  // The lookup itself is label-only, by construction: it has no way to return a
  // coordinate even if a caller wanted one.
  const mapboxText = read('backend/utils/mapbox.js');
  const reverseBody = mapboxText.slice(mapboxText.indexOf('async function reverseGeocode'), mapboxText.indexOf('/* -------------------------------------------------------------- directions */'));
  t.ok(!/coordinate\s*:/.test(reverseBody), 'reverseGeocode never returns a coordinate field at all');
  t.match(reverseBody, /geo\.nearestPlace\(point, 25\)/, 'with no geocoding key it falls back to the nearest known town');
  t.match(reverseBody, /routingReady/, 'and it only spends a network call when a token is configured');
  t.ok(/cacheSet\(key, result\)/.test(reverseBody), 'caching the result, so pinning the same spot twice costs one lookup');

  // A name is only ever attached when it is actually true of the place.
  t.equal(geo.nearestPlace(JUNAGADH, 25).name, 'Junagadh', 'a point in town is named after that town');
  t.equal(geo.nearestPlace(RAJKOT, 25).name, 'Rajkot', 'and so is any other');
  t.equal(geo.nearestPlace([78.4867, 17.385, 0], 25), null, 'a point in a country this gazetteer has never heard of gets no name, rather than the farthest-away one');
  t.equal(geo.nearestPlace([0, 0], 25), null, 'null island is not named either');
  t.equal(geo.nearestPlace('not a coordinate', 25), null, 'and rubbish input is refused rather than throwing');
  const loose = geo.nearestPlace(JUNAGADH, 200);
  t.equal(loose.name, 'Junagadh', 'a wide radius still returns the genuinely nearest town, not a random one');
  t.ok(loose.distanceKm < 1, 'and reports how far away it was, so the caller can judge the name for itself');
  t.equal(geo.nearestPlace(JUNAGADH, 0), null, 'a zero radius names nothing, because nothing is within it');
});

t.describe('a point that cannot be placed says so, instead of blaming the ride', () => {
  // "This ride has no usable road" would be a lie here, and it would send the
  // rider off to wait for a routing outage that is not happening.
  const noPickup = smartRoute.buildRoutePlan(RIDE, { from: 'Flibbertigibbet', to: 'Ahmedabad' }, OPTIONS);
  t.equal(noPickup.ok, false, 'an unknown pickup town is refused');
  t.equal(noPickup.reason, 'pickup_not_located', 'and blamed on the search, not the ride');
  t.match(noPickup.message, /pin on the road/, 'with an action the rider can take');

  const noDrop = smartRoute.buildRoutePlan(RIDE, { from: 'Rajkot', to: 'Flibbertigibbet' }, OPTIONS);
  t.equal(noDrop.reason, 'drop_not_located', 'and the same for an unknown drop town');

  const nothing = smartRoute.buildRoutePlan(RIDE, {}, OPTIONS);
  t.equal(nothing.reason, 'incomplete_search', 'an empty search asks for the missing half rather than guessing');
  t.match(nothing.message, /both a pickup point and a drop point/, 'in words the rider can act on');
});

t.describe('why a straight line could never do this', () => {
  const direct = geo.haversineKm(JUNAGADH, AHMEDABAD);
  const offLine = geo.distanceToSegmentKm(RAJKOT, JUNAGADH, AHMEDABAD);
  t.ok(offLine > 20, `Rajkot is ${offLine.toFixed(1)} km off the direct Junagadh-Ahmedabad line, so a geometric pre-filter or a straight-line match would have hidden this ride`);
  t.ok(direct > offLine, 'and the direct line is shorter than the detour, so it is the road that is wrong, not the town');

  const onRoad = geo.nearestOnRoute(RAJKOT, ROAD);
  t.ok(onRoad, 'but the road really does pass Rajkot');
  t.ok(onRoad.distanceKm < 5, `and it passes within ${onRoad.distanceKm.toFixed(2)} km of it`);
  t.ok(onRoad.alongKm > 0, 'with Rajkot part-way along it, not at either end');
  t.equal(onRoad.point.length, 2, 'and it answers with a real coordinate to show on the map');
  t.equal(geo.nearestOnRoute(RAJKOT, null), null, 'with no road there is no answer, rather than a wrong one');
  t.equal(geo.nearestOnRoute(null, ROAD), null, 'and a null question is no question');
});

t.describe('the owner\'s road is resolved from whatever the Ride document has', () => {
  const resolved = smartRoute.resolveRoute(RIDE);
  t.equal(resolved.coordinates.length, ROAD.length, 'every stored vertex is kept');
  t.deepEqual(resolved.coordinates[0], JUNAGADH, 'starting where the owner said they start');
  t.deepEqual(resolved.coordinates[resolved.coordinates.length - 1], AHMEDABAD, 'and ending where they said they end');
  t.equal(resolved.provider, 'mapbox', 'the provider is reported, not guessed');
  t.equal(resolved.estimated, false, 'a Mapbox route is not an estimate');

  t.equal(smartRoute.resolveRoute({}).coordinates, null, 'a ride with no route resolves to no geometry');
  t.equal(smartRoute.resolveRoute({ routeGeometry: [[70, 21], [70, 22], [70, 23]], routeProvider: 'osrm' }).provider, 'osrm', 'a fallback provider is reported as itself, not hidden behind "mapbox"');
  t.equal(smartRoute.resolveRoute({ routeGeometry: [[70, 21], [70, 22], [70, 23]], routeProvider: 'estimate' }).estimated, true, 'and an estimate is flagged as one');
  t.equal(smartRoute.resolveRoute({ routeGeometry: 'not geometry' }).coordinates, null, 'unusable stored geometry resolves to no geometry rather than crashing');

  // A ride published BEFORE this feature existed. It has no geometry at all, and
  // it must still take part rather than vanish from the feature - with an
  // approximate line, and honestly labelled.
  const legacy = smartRoute.resolveRoute({ from: 'Junagadh', to: 'Ahmedabad' });
  t.ok(legacy.coordinates && legacy.coordinates.length >= 2, 'a legacy offer still gets a usable line');
  t.equal(legacy.provider, 'estimate', 'and it is reported as an estimate');
  t.equal(legacy.estimated, true, 'twice, because that is what the UI has to say out loud');
  t.equal(Math.round(geo.measureLine(legacy.coordinates).totalKm), Math.round(geo.haversineKm(JUNAGADH, AHMEDABAD)), 'and its distance is the honest great-circle one');

  // With a known origin and destination but no geometry, the same applies.
  const endpointsOnly = smartRoute.resolveRoute({ from: 'Nowhere A', to: 'Nowhere B', routeOrigin: JUNAGADH, routeDestination: AHMEDABAD });
  t.equal(endpointsOnly.provider, 'estimate', 'a route with only endpoints is still an estimate');
  t.equal(endpointsOnly.coordinates.length, 6, 'and it is densified, so a segment walk has something to walk');

  const endpoints = smartRoute.routeEndpoints(RIDE);
  t.deepEqual(endpoints.origin, JUNAGADH, 'the origin comes from the stored route');
  t.deepEqual(endpoints.destination, AHMEDABAD, 'the destination comes from the stored route');
  t.deepEqual(smartRoute.routeEndpoints({}).origin, null, 'a ride with no route has no endpoints');
});

/* ------------------------------------------------------------- the policy */

t.describe('the headline case: a Rajkot rider finds a Junagadh ride', () => {
  const plan = smartRoute.buildRoutePlan(RIDE, { from: 'Rajkot', to: 'Ahmedabad' }, OPTIONS);

  t.equal(plan.ok, true, `the plan is accepted (${plan.reason})`);
  t.equal(plan.mode, 'partial', 'it is a part-way join, not a whole-route ride');
  t.equal(plan.board.name, 'Rajkot', 'the rider boards at the town they searched for');
  t.ok(plan.riderKm > 150, `the rider travels most of the road (${plan.riderKm} km)`);
  t.ok(plan.riderKm < plan.totalKm, 'and less than the whole road, which is the point');
  t.ok(plan.boardAlongKm > 0, `boarding happens ${plan.boardAlongKm} km along, not at the start`);
  t.ok(plan.fraction > 0.5 && plan.fraction < 1, `the rider takes ${(plan.fraction * 100).toFixed(1)}% of the road`);
  t.ok(plan.pickupDetourKm < OPTIONS.toleranceKm, 'and the town centre is within the tolerance of the highway');
  t.ok(plan.headingDifferenceDeg !== null && plan.headingDifferenceDeg < 30, 'and the rider is heading the same way the driver is');

  t.ok(plan.legs.driverBefore.length > 1, 'the leg before boarding is drawn, so the rider sees the part they miss');
  t.ok(plan.legs.rider.length > 1, 'the rider\'s own leg is drawn');
  t.ok(plan.legs.driverAfter.length === 0 || plan.legs.driverAfter.length > 1, 'the leg after leaving is drawn, so they see what the driver does next');

  // The three legs must reconstruct the whole road. If they do not, the map is
  // lying about the journey even though the price happens to be right.
  const drawn = plan.legs.driverBefore.length + plan.legs.rider.length + plan.legs.driverAfter.length;
  t.ok(drawn >= ROAD.length - 4, 'the three legs account for every vertex of the road');
});

t.describe('a rider who wants the whole road still gets a full-price match', () => {
  const plan = smartRoute.buildRoutePlan(RIDE, { from: 'Junagadh', to: 'Ahmedabad' }, OPTIONS);
  t.equal(plan.ok, true, 'the plan is accepted');
  t.equal(plan.mode, 'full', 'boarding at the start is a full-route ride');
  t.equal(plan.boardAlongKm, 0, 'boarding is at the very start');
  t.equal(plan.fraction, 1, 'the rider travels all of it');
  t.ok(Math.abs(plan.riderKm - plan.totalKm) < 0.2, 'so the rider distance is the whole distance');
});

t.describe('a pin anywhere on the road is a valid boarding point', () => {
  const mid = geo.pointAtFraction(ROAD, 0.5);
  const plan = smartRoute.buildRoutePlan(RIDE, { from: { lng: mid[0], lat: mid[1], name: 'My pin' }, mode: 'pin' }, OPTIONS);
  t.equal(plan.ok, true, 'a pin on the road is accepted');
  t.equal(plan.mode, 'pin', 'a pin is its own mode');
  t.equal(plan.drop.name, 'Ahmedabad', 'a pin means "ride to where the driver is going"');
  t.ok(Math.abs(plan.riderKm - (plan.totalKm - plan.boardAlongKm)) < 0.2, 'the fare covers the road from the pin to the end');
  t.ok(plan.legs.rider.length > 1, 'the leg from the pin onwards is drawn');
  t.equal(plan.legs.driverBefore.length > 1, true, 'and so is the part the rider misses');
});

t.describe('a rider can pin their DROP as well as their pickup', () => {
  const at = f => geo.pointAtFraction(ROAD, f);
  const pinned = (f, name) => { const p = at(f); return { lng: p[0], lat: p[1], name }; };

  // The gap this closes: pinning existed for one end only, so a rider who wanted
  // to leave before the driver's destination had nowhere to say so, and was
  // charged for the rest of the road whether they wanted it or not.
  //
  // `noDrop` is the pre-existing behaviour, and every other case here is measured
  // against it, so the suite fails loudly if a drop ever stops being honoured.
  const noDrop = smartRoute.buildRoutePlan(RIDE, { from: pinned(0.25, 'My pickup'), mode: 'pin' }, OPTIONS);
  t.equal(noDrop.ok, true, 'a pin with no drop stated is still accepted');
  t.equal(noDrop.mode, 'pin', 'and is still pin mode');
  t.ok(Math.abs(noDrop.riderKm - (noDrop.totalKm - noDrop.boardAlongKm)) < 0.2, 'and still runs to the end of the road, exactly as before');

  const withDrop = smartRoute.buildRoutePlan(RIDE, { from: pinned(0.25, 'My pickup'), to: pinned(0.6, 'My drop'), mode: 'pin' }, OPTIONS);
  t.equal(withDrop.ok, true, 'a pickup pin plus a drop pin is accepted');
  t.equal(withDrop.mode, 'partial', 'and it is a part of the ride, not the whole road');
  t.ok(Math.abs(withDrop.riderKm - (withDrop.dropAlongKm - withDrop.boardAlongKm)) < 0.2, 'the rider is charged for the road between the two pins');
  t.ok(withDrop.riderKm < withDrop.totalKm * 0.5, 'which is much less than the whole road, so the drop really is honoured');
  t.equal(withDrop.drop.name, 'My drop', 'the drop is the point the rider pinned, not where the driver was going');
  t.ok(withDrop.legs.driverAfter.length > 1, 'the part of the road after the drop is still drawn for the driver');

  // Both ends pinned by coordinates is what the buttons actually send.
  const d = at(0.6);
  const coordDrop = smartRoute.buildRoutePlan(RIDE, { from: pinned(0.25, 'My pickup'), to: { lng: d[0], lat: d[1] }, mode: 'pin' }, OPTIONS);
  t.equal(coordDrop.ok, true, 'a drop sent as bare coordinates works, with no name invented for it');

  // A pin on the pickup plus a drop TYPED in the box is the case that was
  // silently wrong: the typed drop used to be discarded unread.
  const typedDrop = smartRoute.buildRoutePlan(RIDE, { from: pinned(0.25, 'My pickup'), to: 'Borsad', mode: 'pin' }, OPTIONS);
  t.equal(typedDrop.ok, true, 'a pinned pickup with a typed drop is accepted');
  t.equal(typedDrop.drop.name, 'Borsad', 'and the drop is the place the rider typed');
  t.ok(typedDrop.riderKm < noDrop.riderKm - 20, 'and the leg stops where the rider asked, well short of the end of the road');

  // Putting the two pins in the wrong order is a very easy mistake now that both
  // ends can be pinned. It is caught by the DIRECTION guard, not the ordering
  // one, and that is deliberate rather than an oversight: a pin far back along
  // the road also points the wrong way, and the direction guard is the cheaper,
  // more specific test. The suite above pins that ordering on purpose, and
  // proves the ordering guard is reached once the heading guard is relaxed.
  const backwards = smartRoute.buildRoutePlan(RIDE, { from: pinned(0.7, 'My pickup'), to: pinned(0.2, 'My drop'), mode: 'pin' }, OPTIONS);
  t.equal(backwards.ok, false, 'a drop behind the pickup is refused');
  t.equal(backwards.reason, 'opposite_direction', 'and the heading guard is the one that catches it');
  t.match(backwards.message, /different trip/, 'so the rider is told it is a different trip, not a vague failure');
  const backwardsLoose = smartRoute.buildRoutePlan(RIDE, { from: pinned(0.7, 'My pickup'), to: pinned(0.2, 'My drop'), mode: 'pin' }, { ...OPTIONS, maxHeadingDifferenceDeg: 180 });
  t.equal(backwardsLoose.reason, 'drop_before_pickup', 'and with the heading guard relaxed it is still refused, as backwards');

  // A pin does not buy a place on a road the ride does not drive.
  const offRoad = smartRoute.buildRoutePlan(RIDE, { from: pinned(0.25, 'My pickup'), to: { lng: 72.9, lat: 21.1, name: 'Far away' }, mode: 'pin' }, OPTIONS);
  t.equal(offRoad.ok, false, 'a drop nowhere near the road is refused');
  t.equal(offRoad.reason, 'drop_off_route', 'with the off-route reason, not a vague failure');
});

t.describe('every way a join can be refused says so in words a rider can act on', () => {
  const cases = [
    {
      name: 'a ride whose towns cannot be located at all',
      ride: { from: 'Nowhere A', to: 'Nowhere B', price: 800 },
      search: { from: 'Rajkot', to: 'Ahmedabad' },
      reason: 'route_unavailable'
    },
    {
      name: 'a search with no drop point',
      ride: RIDE,
      search: { from: 'Rajkot' },
      reason: 'incomplete_search'
    },
    {
      name: 'a pickup a long way off the road',
      ride: RIDE,
      search: { from: { lng: 76, lat: 26, name: 'Delhi' }, to: 'Ahmedabad' },
      reason: 'pickup_off_route'
    },
    {
      name: 'a drop a long way off the road',
      ride: RIDE,
      search: { from: 'Rajkot', to: { lng: 76, lat: 26, name: 'Delhi' } },
      reason: 'drop_off_route'
    },
    {
      name: 'a journey going the other way',
      ride: RIDE,
      search: { from: 'Ahmedabad', to: 'Junagadh' },
      reason: 'opposite_direction'
    },
    {
      name: 'a pin at the very end of the road',
      ride: RIDE,
      search: { from: { lng: AHMEDABAD[0], lat: AHMEDABAD[1] }, mode: 'pin' },
      reason: 'leg_too_short'
    },
    {
      name: 'a two-kilometre hop along the road',
      ride: RIDE,
      search: { from: 'Rajkot', to: { lng: RAJKOT[0] + 0.012, lat: RAJKOT[1] + 0.012, name: 'A bit up the road' } },
      reason: 'leg_too_short'
    }
  ];

  for (const entry of cases) {
    const plan = smartRoute.buildRoutePlan(entry.ride, entry.search, OPTIONS);
    t.equal(plan.ok, false, `${entry.name} is refused`);
    t.equal(plan.reason, entry.reason, `${entry.name} is refused as "${entry.reason}"`);
    t.ok(typeof plan.message === 'string' && plan.message.length > 15, `${entry.name} comes with an explanation`);
    t.notMatch(plan.message, /undefined|NaN|\[object/, `${entry.name} does not leak an unformatted value into the message`);
  }
});

t.describe('a perpendicular join is refused, because it is a different trip', () => {
  // Sanand sits on the road, but heading Sanand -> Gondal heads across the
  // route rather than along it.
  const plan = smartRoute.buildRoutePlan(RIDE, { from: 'Sanand', to: 'Gondal' }, OPTIONS);
  t.equal(plan.ok, false, 'a journey across the road is not part of it');
  t.equal(plan.reason, 'opposite_direction', 'and it is refused for the right reason');
  t.ok(plan.headingDifferenceDeg > 120, `the two headings differ by ${plan.headingDifferenceDeg} degrees`);

  // Loosening the guard admits it, which is what proves the guard is the reason -
  // and it then fails on the NEXT check, for a different and more specific reason.
  const loose = smartRoute.buildRoutePlan(RIDE, { from: 'Sanand', to: 'Gondal' }, { ...OPTIONS, maxHeadingDifferenceDeg: 180 });
  t.ok(loose.reason !== 'opposite_direction', 'with the guard relaxed the same pair is judged on distance instead');
  t.equal(loose.reason, 'drop_before_pickup', 'and is refused for travelling backwards along the road');
  t.equal(loose.ok, false, 'still refused, so the direction guard is a fast path, not the only guard');

  // Heading the same way but asking to be dropped off before being picked up is
  // the same class of nonsense, and gets its own message. The drop point is a
  // coordinate taken from the road itself, so this is purely about the ORDER of
  // the two points along the route.
  const total = geo.measureLine(ROAD).totalKm;
  const earlier = geo.pointAtKm(ROAD, total * 0.6);
  const backwards = smartRoute.buildRoutePlan(RIDE, { from: 'Sanand', to: { lng: earlier[0], lat: earlier[1], name: 'A point further back' } }, { ...OPTIONS, maxHeadingDifferenceDeg: 180 });
  t.equal(backwards.ok, false, 'boarding near the end and leaving further back is backwards');
  t.equal(backwards.reason, 'drop_before_pickup', 'and is said to be backwards, not "off route"');
  t.match(backwards.message, /backwards/, 'in words the rider can act on');
});

t.describe('the tolerance is a decision, not an accident', () => {
  // The exact same pair of towns, judged against a tighter and a looser limit.
  const tight = smartRoute.buildRoutePlan(RIDE, { from: 'Rajkot', to: 'Ahmedabad' }, { ...OPTIONS, toleranceKm: 2 });
  t.equal(tight.ok, false, 'a 2 km tolerance refuses a city-centre pickup beside a highway');
  t.equal(tight.reason, 'pickup_off_route', 'and says the pickup is off the road');
  t.ok(tight.pickupDistanceKm > 2, 'reporting how far off it actually was, so the message is actionable');

  const loose = smartRoute.buildRoutePlan(RIDE, { from: 'Rajkot', to: 'Ahmedabad' }, { ...OPTIONS, toleranceKm: 40 });
  t.equal(loose.ok, true, 'a 40 km tolerance accepts the same pickup');
  t.equal(loose.boardAlongKm > 0, true, 'but the boarding point is still on the road, not at the town centre');
});

/* ----------------------------------------------------------------- the money */

t.describe('the fare is the full fare, prorated by distance', () => {
  const plan = smartRoute.buildRoutePlan(RIDE, { from: 'Rajkot', to: 'Ahmedabad' }, OPTIONS);
  // Rounded by the SAME helper the quote uses, so this is a restatement of the
  // contract rather than a second, possibly different, copy of the arithmetic.
  const expectedFare = Math.max(1, ridePricing.roundMoney(RIDE.price * plan.fraction));
  const quote = smartRoute.planQuote(RIDE, 1, plan);

  t.equal(quote.smart.applied, true, 'the quote records that Smart Route was applied');
  t.equal(quote.smart.farePerSeat, expectedFare, `the fare is Rs ${expectedFare} for ${plan.riderKm} of ${plan.totalKm} km`);
  t.ok(quote.smart.farePerSeat < RIDE.price, 'and less than the whole-route fare');
  t.equal(quote.smart.savedPerSeat, ridePricing.roundMoney(RIDE.price - expectedFare), 'the saving is reported honestly');
  t.equal(quote.price, expectedFare, 'the quote\'s own price field carries the prorated fare');
  t.equal(quote.pricingVersion, 'revex-smart-route-pricing-v1', 'the pricing version says which arithmetic produced it');
  t.match(quote.formula, /km\)/, 'the formula line states the distance it was derived from');
});

t.describe('the platform fee, discount and owner share are computed once, not twice', () => {
  const plan = smartRoute.buildRoutePlan(RIDE, { from: 'Rajkot', to: 'Ahmedabad' }, OPTIONS);
  const quote = smartRoute.planQuote(RIDE, 2, plan);
  const fare = quote.smart.farePerSeat;

  // Everything below must be reproducible with the ORIGINAL calculateRideQuote,
  // called with the prorated inputs. If any of it differs, the UI, the Razorpay
  // order and the stored booking total would disagree.
  const reference = ridePricing.calculateRideQuote({ price: fare, additionalCharges: roundTo(50 * plan.fraction), discountPercent: 0 }, 2);
  t.equal(quote.baseRideAmount, reference.baseRideAmount, 'the base amount matches');
  t.equal(quote.platformFee, reference.platformFee, 'the platform fee matches');
  t.equal(quote.additionalCharges, reference.additionalCharges, 'extras are prorated by the same fraction as the fare');
  t.equal(quote.grandTotal, reference.grandTotal, 'the payable total matches');
  t.equal(quote.ownerShare, reference.ownerShare, 'the owner\'s share matches');
  t.equal(quote.seats, 2, 'the seat count survives the proration');

  const full = smartRoute.planQuote(RIDE, 2, { mode: 'full', totalKm: plan.totalKm });
  t.equal(full.smart.applied, false, 'a full-route plan is NOT prorated');
  t.equal(full.price, RIDE.price, 'and keeps the original price');
  t.equal(full.pricingVersion, 'revex-ride-pricing-v1', 'and is labelled with the original pricing version, not the smart one');
  t.equal(full.additionalCharges, 50, 'extras are not prorated when nothing is prorated');
});

t.describe('the proration cannot be gamed into a free ride', () => {
  const almostNothing = { mode: 'partial', fraction: 0.0001, riderKm: 0.01, totalKm: 315 };
  t.equal(ridePricing.partialFarePerSeat({ price: 800 }, almostNothing).farePerSeat, 1, 'a sliver of a road still costs one rupee, not zero');

  t.equal(ridePricing.partialFarePerSeat({ price: 800 }, { mode: 'partial', fraction: 5, totalKm: 315 }).farePerSeat, 800, 'a fraction above 1 is clamped, not multiplied');
  t.equal(ridePricing.partialFarePerSeat({ price: 800 }, { mode: 'partial', fraction: -3, totalKm: 315 }).farePerSeat, 1, 'a negative fraction is clamped');
  t.equal(ridePricing.partialFarePerSeat({ price: 800 }, { mode: 'partial', fraction: 0.5, totalKm: 0 }).wholeRoute, true, 'with no road length there is nothing to prorate by, so the full fare applies');
  t.equal(ridePricing.partialFarePerSeat({ price: -50 }, { mode: 'partial', fraction: 0.5, totalKm: 100 }).farePerSeat, 1, 'a negative stored price cannot become a negative fare');
  t.equal(ridePricing.partialAdditionalCharges({ additionalCharges: 50 }, { mode: 'partial', fraction: 0.5, totalKm: 100 }), 25, 'extras halve with the fare');
  t.equal(ridePricing.partialAdditionalCharges({ additionalCharges: 50 }, { mode: 'full', totalKm: 100 }), 50, 'extras are untouched for a full-route rider');
});

t.describe('the plan is summarised for a list card without losing anything that matters', () => {
  const plan = smartRoute.buildRoutePlan(RIDE, { from: 'Rajkot', to: 'Ahmedabad' }, OPTIONS);
  const summary = smartRoute.summarisePlan(plan);
  t.equal(summary.ok, true, 'the summary keeps the verdict');
  t.equal(summary.mode, 'partial', 'the mode survives');
  t.equal(summary.riderKm, plan.riderKm, 'the rider distance survives');
  t.equal(summary.totalKm, plan.totalKm, 'the total distance survives');
  t.equal(summary.board.name, 'Rajkot', 'the boarding point survives');
  t.equal(summary.provider, 'mapbox', 'and the UI is still told which provider drew the road');
  t.equal(summary.legs, undefined, 'the legs are NOT on a list card, because a card has no map to put them on');

  const failed = smartRoute.summarisePlan(smartRoute.buildRoutePlan({ from: 'Nowhere A', to: 'Nowhere B' }, { from: 'Rajkot', to: 'Ahmedabad' }, OPTIONS));
  t.equal(failed.ok, false, 'a refusal summarises as a refusal');
  t.ok(failed.message.length > 0, 'with its message');
});

t.describe('a straight-line estimate cannot serve the headline case, and does not pretend to', () => {
  // This is the whole reason there is a real road provider at all. A ride with
  // no stored geometry falls back to a straight line, and Rajkot is 47 km from
  // the Junagadh-Ahmedabad line, so the rider is correctly told they are not on
  // this ride. Silently loosening the tolerance to make it "work" would show
  // riders a ride the driver is nowhere near.
  const estimateOnly = { ...RIDE, routeGeometry: undefined, routeOrigin: undefined, routeDestination: undefined };
  const plan = smartRoute.buildRoutePlan(estimateOnly, { from: 'Rajkot', to: 'Ahmedabad' }, OPTIONS);
  t.equal(plan.ok, false, 'a straight-line fallback does not claim to pass through Rajkot');
  t.equal(plan.reason, 'pickup_off_route', 'it refuses, with the honest reason');
  t.ok(plan.pickupDistanceKm > 40, `and reports the real distance: ${plan.pickupDistanceKm} km`);
  t.equal(plan.estimated, true, 'and it is labelled an estimate, so the UI never claims this was a road');

  // The same ride WITH its real road, matched by exactly the same policy.
  const withRoad = smartRoute.buildRoutePlan(RIDE, { from: 'Rajkot', to: 'Ahmedabad' }, OPTIONS);
  t.equal(withRoad.ok, true, 'is accepted');
  t.equal(withRoad.estimated, false, 'as a real road');
});

t.describe('the public route summary never leaks the road into a list response', () => {
  const summary = smartRoute.routeSummary(RIDE);
  t.ok(summary.distanceKm > 300, 'the distance is there for the card');
  t.ok(summary.durationMin === 0 || summary.durationMin > 0, 'the duration is a number');
  t.equal(summary.provider, 'mapbox', 'the provider is reported');
  t.equal(summary.estimated, false, 'an estimate is flagged as one');
  t.ok(Array.isArray(summary.via), 'via towns are an array');
  t.deepEqual(summary.origin, JUNAGADH, 'the endpoints are included, so the map can frame itself');
  t.deepEqual(summary.destination, AHMEDABAD, 'at both ends');
  t.equal(summary.geometry.length, ROAD.length, 'and the polyline itself, because this is the endpoint that draws it');
  t.equal(smartRoute.routeSummary({}).geometry.length, 0, 'a ride with no road hands out an empty polyline rather than nothing at all');
  t.equal(smartRoute.routeSummary({}).distanceKm, 0, 'and reports a distance of zero, not NaN');
  t.equal(smartRoute.routeSummary({}).error, '', 'with no error to show');
});

t.describe('the human sentence describes the road without inventing it', () => {
  t.equal(smartRoute.describeRoute({ from: 'Nowhere A', to: 'Nowhere B' }), '', 'a ride whose towns cannot be located has no sentence at all, rather than a vague one');

  // RIDE has geometry and a duration of 0 minutes, which is what a straight-line
  // estimate carries. The sentence must then omit the duration rather than print
  // "about 0 m".
  const sentence = smartRoute.describeRoute(RIDE);
  t.match(sentence, /^Junagadh to Ahmedabad, /, 'the sentence names both ends');
  t.match(sentence, /km, via Rajkot, Borsad/, 'the distance and the towns it passes, in that order');
  t.ok(!/about 0/.test(sentence), 'and no "about 0 m", which would be nonsense to a rider');

  const timed = smartRoute.describeRoute({ ...RIDE, routeDurationMin: 248 });
  t.match(timed, /about 4 h 8 m/, 'a real duration is stated in hours and minutes');
  t.match(smartRoute.describeRoute({ ...RIDE, routeDurationMin: 240 }), /about 4 h\b/, 'a whole hour is not written as "4 h 0 m"');
  t.match(smartRoute.describeRoute({ ...RIDE, routeDurationMin: 0, routeVia: [] }), /^Junagadh to Ahmedabad, [\d.]+ km$/, 'with no via towns and no duration, the sentence is just the road');
  t.match(smartRoute.describeRoute(RIDE, { ...smartRoute.routeSummary(RIDE), distanceKm: 315.2, durationMin: 248, via: [{ name: 'Rajkot' }] }), /315\.2 km, about 4 h 8 m, via Rajkot/, 'and it can describe a planned route instead of the stored one');
});

/* ------------------------------------------------- keys, tiers and safety */

t.describe('only a publishable token is ever offered to the browser', () => {
  const withBoth = mapbox.publicConfig({
    MAPBOX_ACCESS_TOKEN: 'sk.eyJ1Ijoic2VjcmV0IiwiYSI6ImNrIn0.sample',
    MAPBOX_PUBLIC_TOKEN: 'REDACTED_MAPBOX_PUBLIC_TOKEN'
  });
  t.equal(withBoth.enabled, true, 'a public token enables the map');
  t.equal(withBoth.token.slice(0, 3), 'pk.', 'and the token sent out is the pk. one');
  t.notMatch(JSON.stringify(withBoth), /sk\./, 'the secret token appears nowhere in the map config');

  // A single SECRET token is the normal case: it routes on the server, and the
  // browser simply gets no interactive basemap rather than a leaked key.
  const secretOnly = mapbox.publicConfig({ MAPBOX_ACCESS_TOKEN: 'sk.eyJ1Ijoic2VjcmV0In0.sample' });
  t.equal(secretOnly.token, '', 'a secret-only configuration sends no token to the browser at all');
  t.notMatch(JSON.stringify(secretOnly), /sk\./, 'and does not send the secret one either');

  t.equal(mapbox.publicConfig({}).enabled, false, 'no keys means no map, which is not an error');
  t.equal(mapbox.publicConfig({}).token, '', 'and no token');
  t.ok(mapbox.publicConfig({}).reason.length > 0, 'but an explanation, so the UI can say why it is drawing a diagram instead');

  t.equal(mapbox.isPublicToken('pk.abc'), true, 'pk. is recognised');
  t.equal(mapbox.isPublicToken('sk.abc'), false, 'sk. is not publishable');
  t.equal(mapbox.isSecretToken('sk.abc'), true, 'sk. is the server-side one');
  // Case matters on purpose. A mis-cased token cannot work either way, and the
  // only safe reading of `SK.…` is "not a key I understand", which routes nothing
  // and publishes nothing. Treating it as public would ship a secret-looking
  // string to every rider's page.
  t.equal(mapbox.tokenKind('SK.abc'), 'unknown', 'a mis-cased prefix is not silently accepted');
  t.equal(mapbox.isPublicToken('SK.abc'), false, 'and can never be published to the browser');
  t.equal(mapbox.isSecretToken('SK.abc'), false, 'nor used for server routing, so it falls back instead of half-working');
  t.equal(mapbox.tokenKind(''), '', 'an absent token has no kind, rather than an "unknown" kind that looks like a mistake');
  t.equal(mapbox.tokenKind('abc'), 'unknown', 'while a malformed one is called unknown');
});

t.describe('the three road-data tiers degrade in the right order', () => {
  const mapboxTier = mapbox.providerConfig({ MAPBOX_ACCESS_TOKEN: 'sk.eyJ1Ijoic2VjcmV0In0.sample' });
  t.equal(mapboxTier.routingReady, true, 'a secret token means Mapbox directions are used');
  t.equal(mapboxTier.toleranceKm > 0, true, 'with a real tolerance');

  const osrmTier = mapbox.providerConfig({ SMART_ROUTE_PUBLIC_ROUTER_ENABLED: 'true' });
  t.equal(osrmTier.routingReady, false, 'with no token, Mapbox directions are not attempted');
  t.equal(osrmTier.publicRouterEnabled, true, 'and the key-free public router is the fallback');
  t.equal(mapbox.describeStatus({}).roadDataSource, 'osrm', 'so road geometry is still real, and it is named osrm');

  const estimateTier = mapbox.providerConfig({ SMART_ROUTE_PUBLIC_ROUTER_ENABLED: 'false' });
  t.equal(estimateTier.publicRouterEnabled, false, 'the fallback can be turned off deliberately');
  t.equal(mapbox.describeStatus({ SMART_ROUTE_PUBLIC_ROUTER_ENABLED: 'false' }).roadDataSource, 'estimate', 'and then the feature says "estimate" rather than pretending');
  t.equal(mapbox.describeStatus({}).routingProblem, undefined, 'a missing key is not a problem to shout about');
});

/* --------------------------------------------------------------- the wiring */

t.describe('the endpoints exist and are declared in a reachable order', () => {
  const routes = read('backend/routes/rides.js');
  for (const [pattern, name] of [
    [/router\.get\('\/map-config'/, 'GET /map-config'],
    [/router\.get\('\/smart-search'/, 'GET /smart-search'],
    [/router\.get\('\/route-preview'/, 'GET /route-preview'],
    [/router\.get\('\/:id\/route'/, 'GET /:id/route']
  ]) {
    t.match(routes, pattern, `${name} is declared`);
  }
  // A literal declared after `/:id` is unreachable, which is a silent failure
  // that looks like "the map does nothing". no-duplicate-routes.test.js enforces
  // the ordering; this asserts the rule is still load-bearing here.
  t.ok(routes.indexOf("'/smart-search'") < routes.indexOf("router.patch('/:id'"), 'GET /smart-search is declared before PATCH /:id');
  t.ok(routes.indexOf("'/map-config'") < routes.indexOf("router.get('/:id'"), 'GET /map-config is declared before GET /:id');
  t.ok(routes.indexOf("router.get('/:id/route'") < routes.indexOf("router.get('/:id',"), 'GET /:id/route is declared before GET /:id');

  t.match(routes, /delete result\.routeGeometry/, 'the polyline is stripped from list responses');
  t.match(routes, /const plan = await planFromRequest\(ride, req\.query\);/, 'the route endpoint rebuilds the plan from its own query');
  t.match(routes, /const plan = await planFromRequest\(ride, req\.body \|\| \{\}\);/, 'and so does the booking endpoint, from the body it was given');
  t.equal((routes.match(/await planFromRequest\(ride/g) || []).length, 3, 'all three endpoints go through the same plan builder, so they cannot disagree about a price');
  t.match(routes, /smartRoute\.buildRoutePlan/, 'the backend decides what a match is, not the browser');

  // `findRideWithRoute` returns a Mongoose QUERY, and the quote endpoint chains
  // `.lean()` onto it. Declaring that helper `async` wraps the query in a
  // promise, and `promise.lean` is not a function - which 500s the ORIGINAL,
  // pre-existing quote endpoint, i.e. a straight regression in code this feature
  // never meant to touch. It is a one-word mistake with a whole endpoint's
  // worth of blast radius, so it is pinned.
  t.match(routes, /\nfunction findRideWithRoute\(id\) \{/, 'the ride-with-route helper is a plain function, so callers can still chain onto the query');
  t.ok(!/async function findRideWithRoute/.test(routes), 'it is not declared async, which would make .lean() unavailable to the quote endpoint');
  t.match(routes, /findRideWithRoute\(req\.params\.id\)\.lean\(\)/, 'and the quote endpoint does chain .lean() onto it');
});

t.describe('a request with no rider points changes nothing at all', () => {
  const routes = read('backend/routes/rides.js');
  // The single most important compatibility property of the whole feature: a
  // request that says nothing about where the rider is must produce no plan at
  // all, so the pre-existing full-route code path runs exactly as it did before
  // this was written. These three lines are that guarantee.
  t.match(routes, /const pinnedPickup = source\.pickupLng !== undefined && source\.pickupLat !== undefined;/, 'a pinned pickup is recognised only when both halves of it are present');
  t.match(routes, /const pinnedDrop = source\.dropLng !== undefined && source\.dropLat !== undefined;/, 'and a pinned drop by the same rule, so half a coordinate is never a location');
  t.match(routes, /if \(!pinnedPickup && !hasText\) return null;/, 'planFromRequest returns null when the request carries no rider points');
  t.match(routes, /if \(!from \|\| !to\) return null;/, 'and when it carries only half a journey, rather than guessing the other half');
  t.match(routes, /if \(!board\) return null;/, 'and when a pinned coordinate turns out to be unusable');

  // A pin used to mean "board here, ride to the driver's own destination", and
  // any drop the rider also gave was thrown away unread. A rider who pinned a
  // pickup AND typed a drop was silently charged for the whole remaining road.
  t.match(routes, /const readDrop = async \(\) => \{[\s\S]*?if \(pinnedDrop\) \{[\s\S]*?\}[\s\S]*?if \(source\.to\) return readSearchPoint\(source\.to\);[\s\S]*?return null;/, 'a drop is read from a pin, from typed text, or reported as not stated - in that order');
  t.match(routes, /if \(source\.to\) return readSearchPoint\(source\.to\);/, 'a drop that was typed is read even when the pickup was pinned, instead of being ignored');
  t.match(routes, /return smartRoute\.buildRoutePlan\(ride, \{ from: board, to: await readDrop\(\), mode: 'pin' \}/, 'and the drop reaches the planner, so the leg is measured board -> drop');
  t.match(routes, /const to = await readDrop\(\);\n  if \(!from \|\| !to\) return null;/, 'and the plain two-point path is unchanged: a half journey is still refused rather than guessed');

  t.match(routes, /router\.get\('\/mine', requireAuth, requireRole\('owner', 'admin'\)/, 'the owner listing is still owner-only');
  t.match(routes, /router\.get\('\/bookings\/my', requireAuth/, 'and the rider listing is still theirs alone');
  t.match(routes, /Admin access is required to view all ride statuses\./, 'the public listing still refuses a non-public status to a non-admin');

  const rides = read('js/rides.js');
  t.match(rides, /\/rides\/\$\{encodeURIComponent\(currentRideId\)\}\/quote\?seats=\$\{seats\}/, 'and the browser still asks the quote endpoint for exactly the query it always did');
});

t.describe('the model carries the road without forcing a migration', () => {
  const model = read('backend/models/Ride.js');
  for (const field of ['routeOrigin', 'routeDestination', 'routeGeometry', 'routeDistanceKm', 'routeDurationMin', 'routeVia', 'routeProvider', 'routeComputedAt', 'routeError']) {
    t.match(model, new RegExp(field), `Ride has ${field}`);
  }
  t.match(model, /routeGeometry: \{[\s\S]{0,200}select: false/, 'the polyline is deselected, so no listing ever pays for it');
  for (const field of ['routeOrigin', 'routeDistanceKm', 'routeVia', 'routeError']) {
    const at = model.indexOf(field);
    t.notMatch(model.slice(at, at + 220), /required: true/, `${field} is optional, so an old document still loads`);
  }
  const booking = read('backend/models/RideBooking.js');
  // A mid-route booking has to be distinguishable from a full-route one for as
  // long as the record lives: the owner's request screen, the cancellation
  // quote and the rider's receipt all read these.
  for (const field of ['boardPoint', 'dropPoint', 'boardName', 'dropName', 'boardAlongKm', 'dropAlongKm', 'riderDistanceKm', 'totalRouteDistanceKm', 'partialRide']) {
    t.match(booking, new RegExp(`\\n  ${field}: \\{`), `a booking records ${field}`);
  }
  t.ok(!/required: true/.test(booking.slice(booking.indexOf('boardPoint'), booking.indexOf('vehicleId'))), 'and every one of them is optional, so a booking made before this feature still loads');
  t.match(booking, /default: false/, 'with a safe default rather than an undefined one');
});

t.describe('the browser module is a real module', () => {
  const map = read('js/route-map.js');
  t.match(map, /\(function \(global\) \{[\s\S]*\}\)\(window\);/, 'it is IIFE-wrapped, so it declares nothing globally by accident');
  t.match(map, /global\.RevexRouteMap = \{/, 'it publishes exactly one namespace');
  t.notMatch(map, /sk\./, 'it contains no secret token');
  t.notMatch(map, /pk\.eyJ/, 'it contains no hard-coded public token either');
  t.match(map, /api\.mapbox\.com\/mapbox-gl-js/, 'the GL JS version comes from the config, not a hard-coded script tag in the HTML');
  t.match(map, /renderDiagram\(\)/, 'it has a renderer that works with no key at all, which is what keeps the feature alive without one');
  t.match(map, /unproject/, 'a click on the keyless diagram is turned back into a real coordinate, so pinning works without a basemap');

  const rides = read('js/rides.js');
  t.match(rides, /\/rides\/smart-search\?/, 'Find Ride calls the smart search');
  t.match(rides, /\/rides\/route-preview\?/, 'the offer form previews the road it is about to publish');
  t.match(rides, /\/rides\/map-config/, 'the public map config is fetched from the server, not hard-coded');
  t.notMatch(rides, /pk\.eyJ|sk\.eyJ/, 'no Mapbox token is in the browser code');
  t.notMatch(rides, /seats \* (Number|price)/, 'and no amount is computed in the browser');
  t.match(rides, /function routeChips/, 'the card states the road distance and the towns it passes');
  t.match(map, /if \(value\.provider !== undefined\) state\.provider/, 'and the search map is told which provider drew its journey, so its legend is not a bare "Route"');
  t.match(rides, /map\.setJourney\(\{\s*geometry: data\.route\?\.geometry,/, 'Find Ride passes that provider through when it draws the rider\'s own road');
});

t.describe('a rider does not lose their journey between the search and the booking', () => {
  // Find Ride says "join at Rajkot, 104.8 km along, ₹536.80 a seat". If the
  // details page cannot see that, it shows the full-route ₹935 and the rider's
  // price rises on the way to payment. That is the single most trust-destroying
  // thing this feature could do, so the carry-over is pinned.
  const rides = read('js/rides.js');
  t.match(rides, /const carried = new URLSearchParams\(location\.search\);/, 'the details screen reads the rider\'s own journey out of the URL it was linked to');
  t.match(rides, /field\.value = carriedFrom;/, 'and puts the pickup back in the join box');
  t.match(rides, /field\.value = carriedTo;/, 'and the drop');
  t.match(rides, /lng\.value = String\(carriedLng\);/, 'and a pinned pickup as coordinates, not as a name');
  t.ok(
    rides.indexOf('const carried = new URLSearchParams(location.search);') < rides.indexOf('await refreshJoin();'),
    'the points are restored BEFORE the first join check and the first quote, not after the full-route price has already been shown'
  );
  t.match(rides, /kept from your search/, 'and the rider is told why the box is already filled in');
  t.notMatch(rides, /set\('from', 'Pinned location'\)/, 'the browser no longer invents a name for a pin: the server reverse-geocodes it instead');

  // The trap that made this return a pin for a link that had none.
  t.match(rides, /carried\.has\('pickupLng'\) && carried\.has\('pickupLat'\)/, 'a pin is only read as a pin when both parameters are actually present');
  t.match(rides, /const hasPin = hasPinParams && Number\.isFinite/, 'because Number(null) is 0 - a finite number - so testing the number alone would place the pickup at null island');
  t.ok(!/const hasPin = Number\.isFinite\(carriedLng\)/.test(rides), 'the finite check alone is not enough, and is not what is used');
});

t.describe('the booking screen can pin its DROP, not just its pickup', () => {
  // A rider can always type a drop, but typing needs a place name the gazetteer
  // happens to know, and a highway exit has no name at all. Pinning the pickup
  // existed and pinning the drop did not, so the one end a rider most often
  // cannot describe in words was the one they could not place.
  const page = read('ride-details.html');
  t.match(page, /id="joinDropLng"/, 'the page holds a hidden field for a pinned drop longitude');
  t.match(page, /id="joinDropLat"/, 'and one for its latitude');
  t.match(page, /id="joinDropPinBtn"[^>]*aria-pressed="false"/, 'and a button that arms the map for the drop, reporting its own state');
  t.match(page, /id="joinPinBtn"/, 'the original pickup button is still there');
  t.ok(page.indexOf('id="joinDropLng"') > -1 && page.indexOf('id="joinPickupLng"') > -1, 'both ends are collected the same way');

  const rides = read('js/rides.js');
  t.match(rides, /let joiningEnd = '';/, 'the screen remembers which end is being pinned');
  t.match(rides, /\[\['joinPinBtn', 'pickup'\], \['joinDropPinBtn', 'drop'\]\]/, 'one loop drives both buttons, so they cannot drift apart');
  t.match(rides, /const next = joiningEnd === label \? '' : label;/, 'pressing the armed button again disarms it, rather than arming both at once');
  t.match(rides, /if \(!coordinate \|\| !joiningEnd\) return;/, 'and a click with nothing armed places no pin, so a stray click cannot move a point the rider never chose');
  t.match(rides, /const suffix = joiningEnd === 'drop' \? 'Drop' : 'Pickup';/, 'the pin is written to the end that is actually being set');
  t.match(rides, /const box = document\.getElementById\(joiningEnd === 'drop' \? 'joinTo' : 'joinFrom'\);/, 'and a pin clears the typed name beside it, because both claiming the same point is how a rider ends up charged for the wrong one');
  t.match(rides, /box\.value = '';/, 'the typed box is emptied, not left to disagree with the pin');

  t.match(rides, /dropLng: coord\('DropLng'\)/, 'the drop coordinate is collected with the pickup one');
  t.match(rides, /query\.set\('dropLng', String\(points\.dropLng\)\);/, 'and is sent on the query, so the route and the quote agree');
  t.match(rides, /payload\.dropLng = points\.dropLng;/, 'and on the booking body, where the server rebuilds the plan and re-prices it');

  // The clear button has to clear BOTH ends. Clearing only the pickup left a drop
  // pin in place while the screen claimed to be back to the full route.
  t.match(rides, /'joinFrom', 'joinTo', 'joinPickupLng', 'joinPickupLat', 'joinDropLng', 'joinDropLat'/, 'choosing the whole route clears the drop pin as well as the pickup pin');

  // refreshJoin() rewrites this message on load, so the sentence in the markup is
  // only ever seen for the few milliseconds before the script runs. Editing one
  // copy and not the other left the page quietly saying something different from
  // what it first promised.
  const staticHint = (page.match(/id="joinMsg">([^<]*)</) || [])[1] || '';
  const runtimeHint = (rides.match(/'Leave both boxes empty to travel the whole route at the full price\.[^']*'/) || [])[0] || '';
  t.ok(staticHint.length > 0, 'the markup carries a default hint');
  t.equal(staticHint, runtimeHint.slice(1, -1), 'and the script rewrites it with exactly the same words, so the two cannot drift apart');
});

t.describe('the pages load the map module, in the right order', () => {
  for (const page of ['find-ride.html', 'ride-details.html', 'offer-ride.html']) {
    const html = read(page);
    t.match(html, /js\/route-map\.js/, `${page} loads the map module`);
    t.ok(html.indexOf('js/route-map.js') < html.indexOf('js/rides.js'), `${page} loads it before the screen script that uses it`);
  }
  const find = read('find-ride.html');
  t.match(find, /id="rideSmartMode"/, 'Smart Route can be switched off, so the original search is never taken away');
  t.match(find, /aria-pressed/, 'the pin buttons report their state');
  t.match(find, /<button[^>]*type="submit"|<button class="rvx-btn rvx-btn--primary" type="submit"/, 'buttons have explicit types');
  const details = read('ride-details.html');
  t.match(details, /id="rideMap"/, 'the ride details page has somewhere to draw the road');
  t.match(details, /id="rideJoin"/, 'and a way to say where the rider is joining it');
  t.match(details, /<label for="joinFrom">/, 'with a real label on the pickup field');
});

t.describe('the keys are documented where a developer will look for them', () => {
  const env = read('.env.example');
  for (const key of [
    'MAPBOX_ACCESS_TOKEN', 'MAPBOX_PUBLIC_TOKEN', 'MAPBOX_STYLE_URL', 'MAPBOX_GL_VERSION',
    'MAPBOX_GEOCODING_BASE', 'MAPBOX_DIRECTIONS_BASE', 'MAPBOX_COUNTRY', 'MAPBOX_TIMEOUT_MS',
    'MAPBOX_CACHE_TTL_MS', 'MAPBOX_CACHE_MAX_ENTRIES', 'MAPBOX_ROUTE_TOLERANCE_KM',
    'MAPBOX_VIA_TOLERANCE_KM', 'MAPBOX_VIA_LIMIT', 'SMART_ROUTE_MID_ROUTE_KM',
    'SMART_ROUTE_MIN_TRAVEL_KM', 'MAPBOX_MIN_MATCH_FRACTION',
    'SMART_ROUTE_MAX_HEADING_DIFFERENCE_DEG', 'SMART_ROUTE_PUBLIC_ROUTER_ENABLED', 'MAPBOX_FALLBACK_ENABLED'
  ]) {
    t.match(env, new RegExp(`^${key}=`, 'm'), `.env.example documents ${key}`);
  }
  t.match(env, /MAPBOX_ACCESS_TOKEN=sk\.sample_replace_this_with_your_mapbox_secret_token/, 'the secret token is shown as an obvious sample, not a real-looking key');
  t.match(env, /MAPBOX_PUBLIC_TOKEN=pk\.sample_replace_this_with_your_mapbox_public_token/, 'and so is the public one');
  t.match(env, /^MAPBOX_ACCESS_TOKEN=$/m, 'the live value is left empty, so nothing secret is committed');
  t.match(env, /account\.mapbox\.com/, 'and it says where to get one');
  // The keys already there must survive.
  t.match(env, /^CHAT_API_KEY=$/m, 'the pre-existing example values are untouched');
  t.match(env, /^RAZORPAY_KEY_SECRET=$/m, 'including the payment ones');
  t.match(env, /^CANCEL_FREE_WINDOW_HOURS=/m, 'and the cancellation window');

  t.match(read('backend/server.js'), /mapbox/, 'the server reports its map configuration at boot');
  t.match(read('backend/server.js'), /roadDataSource/, 'by naming which road-data tier is live');
  t.ok(fs.existsSync(path.join(ROOT, 'scripts', 'backfill-ride-routes.js')), 'there is a script to repair offers published before this feature existed');
  t.match(read('scripts/backfill-ride-routes.js'), /require\('\.\.\/backend\/utils\/rideRoute'\)/, 'and it uses the same writer the API does, not a copy of it');
});

/* ------------------------------------------------------- what is in between */

/**
 * The gazetteer is the one place a route's town names are invented, and a wrong
 * entry is worse than a missing one: a rider who is told they pass through
 * "Sarkhej" while standing in Sanand has been told something false about where
 * they will be. Two entries sharing a coordinate is exactly how that happens -
 * it was a real bug here, with Sanand and Sarkhej both at 72.4667/22.9833, and
 * it is silent, because every individual lookup still returns something.
 */
t.describe('the gazetteer cannot tell two different towns the same place', () => {
  const source = read('backend/utils/geo.js');
  const entries = [...source.matchAll(/\['([a-z0-9-]+)',\s*'([^']+)',\s*(-?[\d.]+),\s*(-?[\d.]+)\]/gi)]
    .map(match => ({ key: match[1], name: match[2], lng: Number(match[3]), lat: Number(match[4]) }));
  t.ok(entries.length > 100, `the gazetteer is populated (${entries.length} towns)`);

  const byCoordinate = new Map();
  for (const entry of entries) {
    const key = `${entry.lng},${entry.lat}`;
    byCoordinate.set(key, [...(byCoordinate.get(key) || []), entry.name]);
  }
  const collisions = [...byCoordinate.entries()].filter(([, names]) => names.length > 1);
  t.deepEqual(collisions, [], 'no two towns share a coordinate');
  t.ok(!/72\.4667,\s*22\.9833/.test(source) || new Set(entries.map(e => `${e.lng},${e.lat}`)).size === entries.length,
    'the Sanand/Sarkhej collision that shipped is gone');

  // A town the rider will actually be told about has to be a real place.
  for (const name of ['Rajkot', 'Sanand', 'Sarkhej', 'Gondal', 'Jetpur', 'Ahmedabad', 'Junagadh']) {
    const entry = entries.find(candidate => candidate.name.toLowerCase() === name.toLowerCase());
    t.ok(entry, `${name} is in the gazetteer`);
    if (entry) {
      t.ok(entry.lng > 68 && entry.lng < 75, `${name} is at a plausible Gujarat longitude`);
      t.ok(entry.lat > 20 && entry.lat < 25, `${name} is at a plausible Gujarat latitude`);
    }
  }

  // Wadhwan shipped at 71.30/22.37, which is roughly 55 km from Wadhwan. It was
  // found the hard way: the Dwarka->Nadiad road lists a "via Wadhwan" that the
  // road-geometry filter then deleted, because the stored point was not the town.
  // Mapbox returns Wadhvan at 71.6796/22.7104 in Surendranagar district, and the
  // gazetteer's own Surendranagar sits 4 km from it, which is the cross-check
  // that makes this a correction rather than a second guess.
  const wadhwan = entries.find(candidate => candidate.key === 'wadhwan');
  t.ok(wadhwan, 'Wadhwan is in the gazetteer');
  t.ok(Math.abs(wadhwan.lng - 71.6796) < 0.01 && Math.abs(wadhwan.lat - 22.7104) < 0.01,
    'Wadhwan is at the place Mapbox geocodes, not 55 km away from it');
  const surendranagar = entries.find(candidate => candidate.key === 'surendranagar');
  if (surendranagar && wadhwan) {
    const gapKm = geo.haversineKm([wadhwan.lng, wadhwan.lat], [surendranagar.lng, surendranagar.lat]);
    t.ok(gapKm > 0.5 && gapKm < 20,
      `Wadhwan and Surendranagar are neighbours, not two strangers (${gapKm.toFixed(1)} km apart)`);
  }
});

/**
 * Sampling is only ever allowed to decide what is worth measuring, never what
 * the answer is. This pins that separation, because the cheap version silently
 * dropped towns on long routes: a 15 km sample grid with a 6 km tolerance has
 * blind spots, and a town the road genuinely passes was being lost in them.
 */
t.describe('sampling shortlists, geometry decides', () => {
  const sampled = geo.viaPointsAlongRoute(ROAD, { toleranceKm: 6, limit: 12 });
  const exact = geo.viaPointsAlongRoute(ROAD, { toleranceKm: 6, limit: 12, exact: true });
  t.deepEqual(sampled.map(entry => entry.name), exact.map(entry => entry.name),
    'the cheap pass and the exact pass find the same towns');
  t.ok(exact.length >= 4, `the fixture road passes several real towns (${exact.map(e => e.name).join(', ')})`);

  for (const entry of exact) {
    const hit = geo.nearestOnRoute(entry.coordinate, ROAD);
    t.ok(hit && hit.distanceKm <= 6, `${entry.name} really is within tolerance of the road`);
    // The reported position is the closest point ON THE ROAD, not the sample.
    t.ok(Math.abs(entry.alongKm - hit.alongKm) < 0.35, `${entry.name}'s distance along is the exact one, not a sample's`);
  }
  const ordered = exact.every((entry, i) => i === 0 || entry.alongKm >= exact[i - 1].alongKm);
  t.ok(ordered, 'the towns come back in the order the road meets them');

  t.deepEqual(geo.viaPointsAlongRoute([], { exact: true }), [], 'no road means no towns');
  t.deepEqual(geo.viaPointsAlongRoute(null, { exact: true }), [], 'and a null road is survivable');
  t.deepEqual(geo.viaPointsAlongRoute(ROAD, { exclude: ['Rajkot'] }).map(e => e.name).includes('Rajkot'), false,
    'an excluded town is left out');
});

/** The number the rider actually asked for: how many towns are between. */
t.describe('the towns between two points on one road', () => {
  const total = geo.measureLine(ROAD).totalKm;
  const whole = geo.townsBetween(ROAD, 0, total);
  t.ok(whole.count > 0, `the whole road names towns (${whole.towns.map(e => e.name).join(', ')})`);
  t.equal(whole.count, whole.towns.length, 'the count is the list length, so a badge cannot lie');

  // A rider boarding part-way must not be shown the towns behind them.
  const boardKm = 100;
  const leg = geo.townsBetween(ROAD, boardKm, total);
  t.ok(leg.towns.every(town => town.fromBoardKm > 0.5), 'every town is ahead of the boarding point');
  t.ok(leg.towns.every(town => town.fromBoardKm < total - boardKm - 0.5), 'and short of the destination');
  t.ok(leg.count <= whole.count, 'a shorter leg can never name more towns than the whole road');
  // NOTE: townsBetween is given no knowledge of what the rider called their
  // pickup, so it cannot know that "the town 5 km ahead" is the one they are
  // standing in. That is done by name, one layer up, in buildLegs - and it is
  // pinned there, in the API-shape suite below. What is guaranteed HERE is the
  // geometric half: nothing at either end of the leg.
  t.ok(leg.towns.every(town => town.fromBoardKm > 0.5),
    'a town at the boarding point is not counted, geometrically');

  // The two ends are the rider's own places, not stops in between.
  for (const entry of whole.towns) {
    t.ok(entry.fromBoardKm >= 0.5, `${entry.name} is not at the very start of the road`);
    t.ok(entry.fromBoardKm <= whole.spanKm - 0.5, `${entry.name} is not at the destination either`);
  }

  t.equal(geo.townsBetween(ROAD, 50, 50).count, 0, 'a zero-length leg passes through nothing');
  t.deepEqual(geo.townsBetween(ROAD, 50, 50).towns, [], 'and names nothing');
  t.equal(geo.townsBetween(ROAD, 200, 50).count, 0, 'a reversed leg is refused, not silently swapped');
  t.equal(geo.townsBetween([], 0, 100).count, 0, 'an empty road has no towns');
  t.equal(geo.townsBetween(null, 0, 100).count, 0, 'and neither has a missing one');
  t.equal(geo.townsBetween(ROAD, 0, 0.2).count, 0, 'a 200 m leg is not a journey through towns');
});

/** Distance marks, the way a navigation app shows progress. */
t.describe('distance checkpoints', () => {
  const marks = geo.distanceCheckpoints(ROAD, { everyKm: 50 });
  const total = geo.measureLine(ROAD).totalKm;
  t.ok(marks.length >= 4, `a ${Math.round(total)} km road gets several marks (${marks.map(m => m.km).join(', ')})`);
  t.ok(marks.every(mark => mark.km % 50 === 0), 'every mark is a whole multiple of the interval');
  t.ok(marks.every(mark => mark.km > 0), 'no marker at zero');
  t.ok(marks.every(mark => mark.km < total), 'and none sitting on the destination');
  for (const mark of marks) {
    t.ok(geo.isCoordinate(mark.coordinate), `the ${mark.km} km mark is a real coordinate`);
  }
  t.equal(geo.distanceCheckpoints(geo.sliceBetween(ROAD, 0, 30), { everyKm: 50 }).length, 0,
    'a leg shorter than the interval gets no markers');
  t.equal(geo.distanceCheckpoints(ROAD, { everyKm: 50, offsetKm: 25 }).length, marks.length,
    'an offset shifts the marks without changing how many there are');
  t.equal(geo.distanceCheckpoints(ROAD, { everyKm: 0 }).length, 0, 'a zero interval cannot divide by zero');
  t.equal(geo.distanceCheckpoints([], { everyKm: 50 }).length, 0, 'an empty road has no marks');
  t.equal(geo.distanceCheckpoints(null, { everyKm: 50 }).length, 0, 'and neither has a missing one');
});

/** The API shape a screen reads. */
t.describe('the checkpoints the API hands to the screen', () => {
  const plan = smartRoute.buildRoutePlan(RIDE, { from: 'Rajkot', to: 'Ahmedabad' }, OPTIONS);
  t.ok(plan.ok, 'the headline case still joins');
  const checkpoints = smartRoute.planCheckpoints(plan);
  t.equal(typeof checkpoints.townsBetween, 'number', 'the count is a number the UI can print');
  t.equal(checkpoints.townsBetween, checkpoints.towns.length, 'and it matches the list it ships with');
  t.ok(checkpoints.distances.length > 0, 'the leg ships with distance marks');
  for (const town of checkpoints.towns) {
    t.ok(typeof town.name === 'string' && town.name, 'a town has a name');
    t.ok(geo.isCoordinate(town.coordinate), 'and a coordinate the map can plot');
    t.ok(town.fromBoardKm > 0, 'and a distance from boarding the rider can read');
  }

  const summary = smartRoute.summarisePlan(plan);
  t.ok(summary.checkpoints, 'a joined plan carries its checkpoints to the client');
  t.equal(summary.checkpoints.townsBetween, checkpoints.townsBetween, 'through the summary unchanged');

  // The rider's own two places are excluded BY NAME, which townsBetween cannot
  // do: it is handed kilometres, not the words the rider typed. A rider who
  // searched "Rajkot to Ahmedabad" must not be told they pass through Rajkot.
  t.equal(checkpoints.towns.some(town => town.name === 'Rajkot'), false,
    'the boarding town is not listed as a town passed through');
  t.equal(checkpoints.towns.some(town => town.name === 'Ahmedabad'), false,
    'and neither is the destination');
  t.equal(plan.legs.townsBetween, checkpoints.towns.length, 'the leg carries the same count as the flattened copy');

  const refused = smartRoute.buildRoutePlan(RIDE, { from: 'Vijaliya', to: 'Ahmedabad' }, OPTIONS);
  if (!refused.ok) {
    t.equal(smartRoute.summarisePlan(refused).checkpoints, null,
      'a refused plan ships no checkpoints, because an empty list would imply a clear road');
  }

  const route = smartRoute.routeSummary(RIDE);
  t.ok(route.checkpoints, 'the whole-road summary carries them too, for the Find Ride map');
  t.ok(Array.isArray(route.checkpoints.towns), 'with a town list');
  t.ok(Array.isArray(route.checkpoints.distances), 'and distance marks');
  t.equal(route.checkpoints.townsBetween, null, 'the whole road has no single "in between" count to quote');
  t.ok(route.checkpoints.distances.every(mark => geo.isCoordinate(mark.coordinate)), 'every mark is plottable');

  t.deepEqual(smartRoute.planCheckpoints({}), { townsBetween: 0, towns: [], distances: [] },
    'a plan with no legs yields empty checkpoints, not a crash');
  t.deepEqual(smartRoute.planCheckpoints(null), { townsBetween: 0, towns: [], distances: [] },
    'and so does no plan at all');
});

/* ------------------------------------------------------ the map component */

/**
 * Five defects were found in the map by looking at it rather than by testing it,
 * and every one of them is invisible to a structural test - the map still
 * "works", it just looks wrong, or gets worse the more a rider uses it. They are
 * pinned here so they cannot come back.
 */
t.describe('the map is a real map, not a diagram that gave up early', () => {
  const map = read('js/route-map.js');

  // 1. The bug behind "it does not look like a real map". `error` fires for a
  //    missing glyph and a single 404'd tile, both of which are routine. The old
  //    handler destroyed a working basemap on the first one.
  t.notMatch(map, /\.on\('error',[\s\S]{0,600}?state\.map\.remove\(\)/,
    'no error handler tears the map down');
  t.notMatch(map, /\.on\('error',[\s\S]{0,600}?renderer = 'diagram'/,
    'and no error handler silently swaps in the diagram');
  t.match(map, /once\('load'/, 'the map is considered working only once it reports load');
  t.match(map, /LOAD_TIMEOUT_MS/, 'with a timeout, so a request that never completes still resolves');
  t.match(map, /if \(state\.mapLoaded\) return;/,
    'and errors are ignored once it has loaded, which is where tile noise arrives');
  t.match(map, /catch \(error\)[\s\S]{0,700}?renderer = 'diagram'/,
    'a map that cannot start at all - no WebGL - still degrades to the diagram');

  // 2. A leak: a new source id per render, and markers that were never removed.
  t.match(map, /const SOURCE_ID = 'revex-route';/, 'the route source has a stable id');
  t.notMatch(map, /sourceIds/, 'no per-render source counter is left over');
  t.match(map, /source\.setData\(collection\)/, 're-rendering updates the data instead of adding a source');
  t.match(map, /function buildMarkers[\s\S]{0,80}?clearMarkers\(\)/,
    'and every render clears the previous markers first');

  // 3. Every pin was the same teal dot, so start, board, drop and end were
  //    indistinguishable - the one thing the map exists to communicate.
  for (const kind of ['start', 'pickup', 'drop', 'end']) {
    t.match(map, new RegExp(`pinElement\\('${kind}'`), `the ${kind} pin is drawn`);
  }
  t.notMatch(map, /new mapboxgl\.Marker\(\{\s*color:/, 'no more anonymous default-colour markers');

  // 4. The towns the server computed were thrown away.
  t.match(map, /setCheckpoints\(checkpoints\)/, 'the map accepts the towns and the distance marks');
  t.match(map, /townElement\(town\.name, town\.fromBoardKm\)/, 'and draws each town by name');
  t.match(map, /checkpointElement\(mark\.km\)/, 'and each distance mark');
  t.match(map, /value\.townsBetween === undefined \|\| value\.townsBetween === null[\s\S]{0,160}?Math\.trunc\(toNumber\(value\.townsBetween, state\.towns\.length\)\)/,
    'the count is taken from the server, so the badge and the dots cannot disagree');

  // 5. Nothing to judge size by, and no way to see the street names underneath.
  t.match(map, /ScaleControl/, 'there is a scale bar, in metric');
  t.match(map, /unit: 'metric'/, 'and it is in kilometres, like every other number on the page');
  t.match(map, /FullscreenControl/, 'and a fullscreen control');
  t.match(map, /attributionControl: true/, 'and Mapbox attribution is left visible, as its terms require');
  t.notMatch(read('css/revex-ui.css'), /\.mapboxgl-ctrl-bottom-right\s*\{\s*display:\s*none/,
    'and nothing in the CSS hides the attribution');

  // Casing is what makes a route readable over a busy basemap.
  t.match(map, /casing: true/, 'segments declare a casing');
  t.match(read('css/revex-ui.css'), /\.rvx-map__line--casing/, 'and the stylesheet draws it');
  t.match(read('css/revex-ui.css'), /\.rvx-map--dense \.rvx-map__checkpoint \{ display: none; \}/,
    'distance pills step aside when zoomed out, instead of becoming noise');

  // HTML markers rather than Mapbox symbol layers: a symbol layer needs a glyph
  // endpoint, and a failed glyph request renders an empty box with no error.
  t.match(map, /document\.createElement\('div'\)/, 'our own labels are built as DOM, not as symbol layers');
  t.notMatch(map, /'symbol'\s*:\s*true|'text-field'/, 'no label depends on a font or sprite fetch');

  t.match(map, /for \(const segment of SEGMENTS\) \{\n\s*if \(!segment\.casing\) continue;/,
    'casings go down before lines go on top');
});

/**
 * The two defects that were still standing after the map was rewritten.
 *
 * Both were found by watching the real page rather than by reading the code:
 * the basemap loaded, `load` fired, the status said "Road route by Mapbox", and
 * the map still drew nothing. A passing-looking status is exactly what made
 * these survive a rewrite - so they are pinned here structurally.
 */
t.describe('the basemap gets a container of its own, at full size, before it is asked to draw', () => {
  const map = read('js/route-map.js');
  const css = read('css/revex-ui.css');

  // 1. GL JS requires an empty container, and warns loudly when it is not one.
  //    Sharing `surface` with the diagram left the diagram's placeholder <p>
  //    sitting inside a live basemap, and meant clearing the diagram would also
  //    have detached the canvas.
  t.match(map, /const glHost = document\.createElement\('div'\);/,
    'the basemap has a dedicated host element');
  t.match(map, /const diagramHost = document\.createElement\('div'\);/,
    'and the keyless diagram has a different one');
  t.match(map, /container: glHost,/, 'so Mapbox is given the empty host, not the shared surface');
  t.notMatch(map, /container: surface,/, 'the shared surface is never handed to Mapbox');
  t.match(map, /diagramHost\.innerHTML = '';/,
    'clearing the diagram touches only the diagram');
  t.notMatch(map, /surface\.innerHTML = '';/,
    'and nothing ever empties the surface out from under a loaded map');

  // 2. `hidden` is not a style. Without these two rules the "hidden" host is
  //    still laid out, so the diagram is drawn on top of a live basemap.
  t.match(css, /\.rvx-map \.rvx-map__gl\[hidden\]/, 'the hidden rule is scoped to the map');
  t.match(css, /\.rvx-map__diagram\[hidden\] \{ display: none; \}/, 'and really sets display: none');

  // 3. Mapbox adds its own `mapboxgl-map` class to the container and ships
  //    `.mapboxgl-map { position: relative }`, injected into <head> AFTER our
  //    stylesheet. At equal specificity the later rule wins: `relative` beat
  //    `absolute`, `inset: 0` did nothing, and the host collapsed to zero
  //    height - which took the entire basemap with it. The selectors are
  //    therefore doubled, and this pins that decision.
  t.match(css, /\.rvx-map \.rvx-map__gl,\n\.rvx-map \.rvx-map__diagram \{\n  position: absolute;/,
    'the host selectors are doubled in specificity so Mapbox cannot outrank them');
  t.notMatch(css, /\.rvx-map__gl,\s*\.rvx-map__diagram \{/, 'the single-class form would lose again');
  t.match(css, /\.rvx-map \.rvx-map__gl \{ z-index: 1; \}/, 'the basemap sits above the diagram');

  // 4. `addSource`/`addLayer` throw "Style is not done loading" before the
  //    style arrives - and `setConfig` is the call that turns the map on, so it
  //    always runs first. The route has to wait for `load` and be re-rendered,
  //    not race the style.
  t.match(map, /if \(!state\.mapLoaded \|\| \(typeof map\.isStyleLoaded === 'function' && !map\.isStyleLoaded\(\)\)\) \{\s*\n\s*buildMarkers\(mapboxgl\);\s*\n\s*return true;/,
    'layers are not added until the style is loaded, and markers are still drawn meanwhile');
  t.match(map, /state\.map\.once\('load'/, 'and the style arriving re-renders the route');

  // 5. GL JS measures its container once and caches the size. The Find Ride
  //    panel is `hidden` until a search runs, and FullscreenControl re-sizes
  //    the map into the whole window; without being told, the map keeps
  //    rendering at the dimensions it was born with.
  t.match(map, /new global\.ResizeObserver/, 'the container is watched for size changes');
  t.match(map, /state\.map\.resize\(\)/, 'and the map is resized when it does');
  t.match(map, /state\.resizeObserver\.disconnect\(\)/,
    'the observer is released on destroy, or a closed panel keeps the map alive');
});

t.describe('every screen labels its road, and says how many towns it passes', () => {
  const rides = read('js/rides.js');
  t.match(rides, /function checkpointStrip\(checkpoints\)/, 'there is one function that renders the towns between');
  t.match(rides, /No towns in between/, 'and it says so when the answer is none, rather than showing an empty box');
  t.match(rides, /\$\{count === 1 \? 'town' : 'towns'\} in between/, 'and it agrees in number with the list');
  t.match(rides, /checkpointStrip\(match\.checkpoints/, 'the match card shows the rider\'s own leg');
  t.equal((rides.match(/setCheckpoints\(/g) || []).length, 3,
    'all three map screens are wired: search, details and the offer preview');
  t.match(rides, /map\.setCheckpoints\(data\.route\?\.checkpoints/, 'the search map labels the rider\'s own road');
  t.match(rides, /setCheckpoints\(match\?\.ok \? \(match\.checkpoints \|\| null\) : \(route\.checkpoints \|\| null\)\)/,
    'the details map shows the joined leg when there is one, and the whole road otherwise');
  t.match(rides, /live\?\.setCheckpoints\(data\.checkpoints/, 'the offer preview labels the road being published');
  t.match(read('css/revex-ui.css'), /\.rvx-stops__head/, 'and the list is styled as the evidence for the count');
});

/* ----------------------------------------------------------------- helpers */

function roundTo(value) {
  return Math.round(Number(value) * 100) / 100;
}

t.done();

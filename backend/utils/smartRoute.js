/**
 * SMART ROUTE MATCHING  (backend/utils/smartRoute.js)
 *
 * The policy layer. It answers one question and nothing else:
 *
 *   "Does this rider's journey sit on this ride's road, and what would they pay?"
 *
 * It is deliberately PURE - no database, no network, no environment. Everything
 * it needs is handed to it. That is what makes the whole matching rule set
 * testable offline, and it is why the same functions are reused by the quote
 * endpoint, the booking endpoint and the search endpoint without any of them
 * being able to disagree.
 *
 * WHY A RIDER TRAVELLING A SHORTER DISTANCE IS NOT A DIFFERENT RIDE
 *
 * Junagadh -> Ahmedabad physically drives THROUGH Rajkot. A rider who searches
 * "Rajkot -> Ahmedabad" is not asking for a different ride; they are asking to
 * get on this one halfway. Text comparison cannot see that. Comparing the two
 * rider points against the ride's actual ROAD GEOMETRY can, which is what this
 * module does.
 *
 * THE REJECTION RULES, AND WHY EACH ONE EXISTS
 *
 *   1. off-route         A pickup 30 km from the road is not "on" the ride.
 *   2. backwards         Dropping before boarding means travelling in reverse.
 *   3. too short         Joining for 1 km saves the rider a token amount and
 *                        costs the owner a stop, a wait and a detour.
 *   4. wrong direction   A pickup near the road but heading the other way is
 *                        a different journey, not a shorter one.
 *
 * Rule 4 is what stops the classic false positive: a ride on the Ahmedabad-Rajkot
 * highway "matches" a point 2 km from it no matter which way that point faces.
 * Comparing the ride's own start-to-end bearing with the rider's pickup-to-drop
 * bearing is what separates "joining" from "coincidence".
 *
 * The thresholds are all environment-configurable (see mapbox.js) because a
 * service-area city and a hill route need different numbers.
 */
'use strict';

const geo = require('./geo');
// The pricing arithmetic lives in ridePricing, not here: there must be exactly
// one implementation of "what a rider pays", and this module only decides which
// plan applies. ridePricing never requires this module, so there is no cycle.
const pricing = require('./ridePricing');

const FULL_ROUTE = 'full';
const PARTIAL_ROUTE = 'partial';
const PIN_JOIN = 'pin';

/* ------------------------------------------------------------- tolerances */

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clean(value, max = 160) {
  return String(value ?? '').trim().slice(0, max);
}

function round1(value) {
  return Math.round(num(value, 0) * 10) / 10;
}

function roundKm(value) {
  return Math.max(0, round1(value));
}

/** The two names a ride was published with, normalised for comparison. */
function placeKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/* ------------------------------------------------------ route resolution */

/**
 * The polyline to reason about, for a ride that may predate this feature.
 *
 * Order of preference:
 *   1. the stored real road geometry,
 *   2. a straight line between the stored origin/destination coordinates,
 *   3. a straight line between the two towns resolved from the gazetteer.
 *
 * This is the reason a ride created months ago, before the feature existed,
 * still participates: it simply gets an approximate line instead of a real one.
 * Losing those rides from the feature would be the single biggest way to make
 * it look like the feature was half-finished.
 */
function resolveRoute(ride = {}) {
  const stored = geo.toLineCoordinates(ride.routeGeometry);
  if (stored) {
    return { coordinates: stored, provider: clean(ride.routeProvider, 40) || 'mapbox', estimated: clean(ride.routeProvider, 40) === 'estimate' };
  }
  const origin = geo.toCoordinate(ride.routeOrigin);
  const destination = geo.toCoordinate(ride.routeDestination);
  if (origin && destination) {
    return { coordinates: geo.straightLine([origin, destination], 5), provider: 'estimate', estimated: true };
  }
  const from = geo.gazetteerLookup(ride.from);
  const to = geo.gazetteerLookup(ride.to);
  if (from && to) {
    return { coordinates: geo.straightLine([from.coordinate, to.coordinate], 5), provider: 'estimate', estimated: true };
  }
  return { coordinates: null, provider: 'unknown', estimated: true };
}

/** The ride's origin/destination coordinates, resolved as above. */
function routeEndpoints(ride = {}) {
  const { coordinates } = resolveRoute(ride);
  if (!coordinates) return { origin: null, destination: null };
  return { origin: coordinates[0], destination: coordinates[coordinates.length - 1] };
}

/* --------------------------------------------------------- the plan itself */

/** A plan with a clear reason, so the API and the UI never have to invent one. */
function reject(reason, message, extra = {}) {
  return { ok: false, mode: FULL_ROUTE, reason, message, ...extra };
}

function pointSummary(name, hit) {
  return {
    name: clean(name, 120),
    coordinate: hit.point,
    distanceKm: roundKm(hit.distanceKm),
    alongKm: roundKm(hit.alongKm),
    fraction: Math.round(hit.fraction * 10000) / 10000
  };
}

/**
 * Decides whether a rider's journey can join a ride, and for how much of it.
 *
 * @param {object} ride     the stored Ride document
 * @param {object} search   the rider's two points
 *        search.from      { name?, lng?, lat? } or a plain string
 *        search.to        { name?, lng?, lat? } or a plain string
 *        search.mode      'text' (default) or 'pin' - a pinned pickup joins the
 *                         rest of the route, so only a pickup is needed
 * @param {object} options  the resolved tolerances (from mapbox.providerConfig)
 * @returns {object}        a plan; `{ ok: true }` means the rider can join
 */
function buildRoutePlan(ride = {}, search = {}, options = {}) {
  const toleranceKm = clamp(num(options.toleranceKm, geo.DEFAULT_TOLERANCE_KM), 0.5, 100);
  const midRouteKm = clamp(num(options.midRouteKm, 5), 0, 100);
  const minTravelKm = clamp(num(options.minTravelKm, geo.MIN_TRAVEL_KM), 0, 100);
  const minMatchFraction = clamp(num(options.minMatchFraction, 0.03), 0, 0.9);
  const maxHeadingDifference = clamp(num(options.maxHeadingDifferenceDeg, geo.MAX_HEADING_DIFFERENCE_DEG), 10, 180);

  const { coordinates, provider, estimated } = resolveRoute(ride);
  const totalKm = coordinates ? geo.measureLine(coordinates).totalKm : 0;
  const via = Array.isArray(ride.routeVia) ? ride.routeVia : [];

  const base = {
    rideId: clean(ride._id || ride.id, 40),
    from: clean(ride.from, 120),
    to: clean(ride.to, 120),
    date: ride.date || null,
    time: clean(ride.time, 20),
    totalKm: roundKm(totalKm),
    provider,
    estimated: Boolean(estimated),
    toleranceKm,
    midRouteKm,
    minTravelKm,
    minMatchFraction,
    via: via.map(entry => ({ name: clean(entry?.name, 120), alongKm: roundKm(entry?.alongKm) })).filter(entry => entry.name),
    coordinates
  };

  if (!coordinates) {
    return reject('route_unavailable',
      'The road route for this ride is not available yet, so mid-route joining is switched off for it.',
      base);
  }

  const requested = normaliseSearch(search);
  if (!requested) {
    return reject('incomplete_search', 'Enter both a pickup point and a drop point to search for rides on this route.', base);
  }

  // ---- the rider boards here -------------------------------------------------
  // A point that could not be placed at all is a different problem from a ride
  // with no road, and saying so matters: the fix is a better search, not waiting.
  if (!requested.from.coordinate) {
    return reject('pickup_not_located',
      `We could not find "${requested.from.name || 'your pickup point'}" on the map. Try a nearby town name, or drop a pin on the road instead.`,
      { ...base, mode: requested.mode || 'full' });
  }
  if (requested.to && !requested.to.coordinate) {
    return reject('drop_not_located',
      `We could not find "${requested.to.name || 'your drop point'}" on the map. Try a nearby town name, or drop a pin on the road instead.`,
      { ...base, mode: requested.mode || 'full' });
  }
  const boardHit = geo.nearestOnRoute(requested.from.coordinate, coordinates);
  if (!boardHit) {
    return reject('route_unavailable', 'This ride has no usable road geometry yet.', base);
  }
  if (boardHit.distanceKm > toleranceKm) {
    return reject('pickup_off_route',
      `"${requested.from.name || 'Your pickup'}" is about ${roundKm(boardHit.distanceKm)} km from this ride's road, which is more than the ${toleranceKm} km limit.`,
      { ...base, pickupDistanceKm: roundKm(boardHit.distanceKm), board: pointSummary(requested.from.name, boardHit) });
  }

  const board = pointSummary(requested.from.name, boardHit);

  // ---- pin-join mode: ride to the driver's own destination -------------------
  // Only when the rider did not say where they are getting off. A pin WITH a drop
  // falls through to the normal two-point path below, so a rider who pins a drop
  // is measured board -> drop on exactly the same code, with the same direction
  // guard, the same length guard and the same town count as a typed journey.
  if (requested.mode === PIN_JOIN && !requested.to) {
    const dropPoint = coordinates[coordinates.length - 1];
    const riderKm = Math.max(0, totalKm - boardHit.alongKm);
    if (riderKm < minTravelKm) {
      return reject('leg_too_short',
        `You are only ${roundKm(riderKm)} km from the end of this ride's route, so there is not enough left to join.`,
        { ...base, mode: PIN_JOIN, board, riderKm: roundKm(riderKm) });
    }
    const fraction = totalKm > 0 ? riderKm / totalKm : 1;
    if (fraction < minMatchFraction) {
      return reject('leg_too_short', 'The remaining part of this ride is too short to join.', { ...base, mode: PIN_JOIN, board, riderKm: roundKm(riderKm) });
    }
    return {
      ok: true,
      ...base,
      mode: PIN_JOIN,
      reason: 'on_route',
      message: `You can join at ${requested.from.name || 'your pin'}, ${roundKm(riderKm)} km before ${base.to}.`,
      board,
      drop: { name: base.to, coordinate: dropPoint, distanceKm: 0, alongKm: roundKm(totalKm), fraction: 1 },
      boardAlongKm: board.alongKm,
      dropAlongKm: roundKm(totalKm),
      riderKm: roundKm(riderKm),
      fraction: Math.round(fraction * 10000) / 10000,
      pickupDetourKm: board.distanceKm,
      dropDetourKm: 0,
      headingDifferenceDeg: null,
      legs: buildLegs(coordinates, boardHit.alongKm, totalKm, base, [requested.from.name])
    };
  }

  // ---- the rider drops off here ----------------------------------------------
  const dropHit = geo.nearestOnRoute(requested.to.coordinate, coordinates);
  if (!dropHit) {
    return reject('route_unavailable', 'This ride has no usable road geometry yet.', base);
  }
  if (dropHit.distanceKm > toleranceKm) {
    return reject('drop_off_route',
      `"${requested.to.name || 'Your drop point'}" is about ${roundKm(dropHit.distanceKm)} km from this ride's road, which is more than the ${toleranceKm} km limit.`,
      { ...base, dropDistanceKm: roundKm(dropHit.distanceKm), board, drop: pointSummary(requested.to.name, dropHit) });
  }

  const drop = pointSummary(requested.to.name, dropHit);

  // ---- direction guard ------------------------------------------------------
  const endpoints = routeEndpoints(ride);
  const rideBearing = endpoints.origin && endpoints.destination
    ? geo.bearingDeg(endpoints.origin, endpoints.destination)
    : null;
  const riderBearing = geo.bearingDeg(requested.from.coordinate, requested.to.coordinate);
  const headingDifferenceDeg = rideBearing === null
    ? null
    : Math.round(geo.headingDifferenceDeg(rideBearing, riderBearing));
  if (headingDifferenceDeg !== null && headingDifferenceDeg > maxHeadingDifference) {
    return reject('opposite_direction',
      `Your journey heads ${headingDifferenceDeg}° away from this ride's direction, so it is a different trip rather than part of it.`,
      { ...base, board, drop, headingDifferenceDeg });
  }

  // ---- length guard ---------------------------------------------------------
  const riderKm = dropHit.alongKm - boardHit.alongKm;
  if (riderKm <= 0) {
    return reject('drop_before_pickup',
      'Your drop point comes before your pickup point on this ride, which would mean travelling backwards.',
      { ...base, board, drop });
  }
  if (riderKm < minTravelKm) {
    return reject('leg_too_short',
      `You would travel only ${roundKm(riderKm)} km on this ride. Join it from at least ${minTravelKm} km earlier.`,
      { ...base, board, drop, riderKm: roundKm(riderKm) });
  }
  const fraction = totalKm > 0 ? riderKm / totalKm : 1;
  if (fraction < minMatchFraction) {
    return reject('leg_too_short',
      'That is a very small part of this ride, so it is not shown as a match.',
      { ...base, board, drop, riderKm: roundKm(riderKm), fraction: Math.round(fraction * 10000) / 10000 });
  }

  // Is the rider taking a seat from the very start, or genuinely joining midway?
  const joiningMidRoute = boardHit.alongKm > midRouteKm || boardHit.alongKm > totalKm * 0.02;
  const mode = joiningMidRoute ? PARTIAL_ROUTE : FULL_ROUTE;

  return {
    ok: true,
    ...base,
    mode,
    reason: 'on_route',
    message: mode === PARTIAL_ROUTE
      ? `You join this ride at ${requested.from.name || 'your pickup point'}, ${roundKm(boardHit.alongKm)} km along the route.`
      : 'This ride covers your whole journey.',
    board,
    drop,
    boardAlongKm: roundKm(boardHit.alongKm),
    dropAlongKm: roundKm(dropHit.alongKm),
    riderKm: roundKm(riderKm),
    fraction: Math.round(fraction * 10000) / 10000,
    pickupDetourKm: board.distanceKm,
    dropDetourKm: drop.distanceKm,
    headingDifferenceDeg,
    joiningMidRoute,
    legs: buildLegs(coordinates, boardHit.alongKm, dropHit.alongKm, base, [requested.from.name, requested.to.name])
  };
}

/** Accepts a string, a `{lng,lat}` object or a `{name,lng,lat}` object. */
function normaliseSearch(search = {}) {
  const mode = String(search.mode || '').toLowerCase() === PIN_JOIN ? PIN_JOIN : null;
  const from = readPoint(search.from);
  if (!from) return null;
  // A pin used to mean "board here and ride to the driver's own destination",
  // and the drop was discarded right here. That is precisely why a rider could
  // pin a pickup but never a drop: there was nowhere for the drop to go. It is
  // carried through now whenever one is supplied - pinned or typed - and stays
  // optional, so a pin with no drop still means exactly what it meant before.
  if (mode === PIN_JOIN) return { mode, from, to: readPoint(search.to) };
  const to = readPoint(search.to);
  if (!to) return null;
  return { mode: null, from, to };
}

/**
 * Accepts a place in any of the three shapes that reach this module.
 *
 *   "Rajkot"                              a name
 *   [lng, lat]                            a bare pair
 *   { name, lng, lat }                    what a query string and a pin produce
 *   { name, coordinate: [lng, lat] }      what another helper in THIS file
 *                                         returns (pointSummary, resolveRoute)
 *
 * All three are accepted on purpose. The shape a caller happens to hold is not a
 * reason to silently drop a rider's pickup point: doing that returns a plan with
 * no geometry question asked, which surfaces as "this ride has no usable road"
 * on a ride that has one - a confusing failure that no endpoint-level test
 * notices, because the endpoint's own request shape is one of the three.
 */
function readPoint(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const name = clean(value, 120);
    if (!name) return null;
    const local = geo.gazetteerLookup(name);
    return local ? { name: local.name, coordinate: local.coordinate } : { name, coordinate: null, unresolved: true };
  }
  if (typeof value !== 'object') return null;
  const name = clean(value.name, 120);
  const coordinate = geo.toCoordinate(value)
    || geo.toCoordinate(value.coordinate)
    || geo.toCoordinate([value.lng, value.lat])
    || geo.toCoordinate([value.lon, value.lat])
    || geo.toCoordinate([value.longitude, value.latitude]);
  if (!coordinate) return name ? { name, coordinate: null, unresolved: true } : null;
  return { name, coordinate };
}

/** How far off the road a town may sit and still count as "passed through". */
const VIA_TOLERANCE_KM = 6;
/** The most towns we will name on a card. A list nobody reads is not helpful. */
const VIA_LIMIT = 8;
/** Distance markers on the rider's leg, like a navigation app. */
const CHECKPOINT_EVERY_KM = 50;

/**
 * The geometry the UI draws, split into the part before the rider boards, their
 * own leg, and the part after they leave. Drawing all three is what makes the
 * feature legible at a glance: the rider sees exactly where they get on and off.
 *
 * It also carries the checkpoints - the towns passed and the 50 km marks - so a
 * screen never has to recompute them from the geometry. `exclude` is the places
 * the rider is standing at either end: the town you are leaving is not one you
 * "pass through", and the ride's own endpoints are not towns on the leg either.
 */
function buildLegs(coordinates, boardAlongKm, dropAlongKm, base, exclude = []) {
  const total = geo.measureLine(coordinates).totalKm;
  const rider = geo.sliceBetween(coordinates, boardAlongKm, dropAlongKm);
  const between = geo.townsBetween(coordinates, boardAlongKm, dropAlongKm, {
    toleranceKm: VIA_TOLERANCE_KM,
    limit: VIA_LIMIT,
    exclude: [...exclude, base?.from, base?.to].filter(Boolean)
  });
  return {
    driverBefore: geo.sliceBetween(coordinates, 0, boardAlongKm),
    rider,
    driverAfter: dropAlongKm < total ? geo.sliceBetween(coordinates, dropAlongKm, total) : [],
    totalKm: roundKm(total),
    // Counted here, on the server, rather than left to the client to read off
    // the array length: the badge and the list are then the same number by
    // construction and cannot drift apart.
    townsBetween: between.count,
    towns: between.towns,
    checkpoints: geo.distanceCheckpoints(rider, { everyKm: CHECKPOINT_EVERY_KM })
  };
}

/* ------------------------------------------------------------------ quoting */

/**
 * The distance-proportional fare for one seat.
 *
 * Re-exported from ridePricing rather than reimplemented here, so the number on
 * the quote screen, the number in the Razorpay order and the number stored on
 * the booking all come from one function.
 */
function partialFarePerSeat(ride = {}, plan = {}) {
  return pricing.partialFarePerSeat(ride, plan);
}

function partialAdditionalCharges(ride = {}, plan = {}) {
  return pricing.partialAdditionalCharges(ride, plan);
}

/**
 * A full, display-ready quote for a partial ride: ridePricing's numbers plus the
 * Smart Route details the UI shows next to them.
 */
function planQuote(ride = {}, seats = 1, plan = {}) {
  const quote = pricing.calculatePartialRideQuote(ride, seats, plan);
  const smart = quote.smart || {};
  return {
    ...quote,
    smart: {
      ...smart,
      estimated: Boolean(plan.estimated),
      provider: clean(plan.provider, 40) || smart.provider || 'mapbox',
      label: smart.applied
        ? `Smart Route: ${roundKm(plan.riderKm)} km of ${roundKm(plan.totalKm)} km`
        : 'Full route',
      checkpoints: plan.ok ? planCheckpoints(plan) : null
    }
  };
}

/* ------------------------------------------------------------- checkpoints */

/**
 * The "what is on the way" detail, flattened out of `plan.legs` so every screen
 * can read it without knowing how the geometry is split up.
 *
 * This is the answer to the question a rider actually asks before booking a
 * partial ride: not "is there a road" but "how many towns do I pass, and where
 * are the distance marks". Counted on the server so the badge, the list and the
 * map markers are all reading the same number.
 */
function planCheckpoints(plan) {
  // `plan = {}` would not cover this: a default parameter only fires for
  // `undefined`, and a rejected plan can legitimately arrive as null.
  const source = plan || {};
  const legs = source.legs || {};
  const towns = Array.isArray(legs.towns) ? legs.towns : [];
  const marks = Array.isArray(legs.checkpoints) ? legs.checkpoints : [];
  return {
    townsBetween: Math.max(0, Math.trunc(num(legs.townsBetween, towns.length))),
    towns: towns
      .map(entry => ({
        name: clean(entry?.name, 120),
        fromBoardKm: roundKm(entry?.fromBoardKm),
        coordinate: geo.toCoordinate(entry?.coordinate)
      }))
      .filter(entry => entry.name && entry.coordinate),
    distances: marks
      .map(entry => ({
        km: roundKm(entry?.km),
        fromBoardKm: roundKm(entry?.fromBoardKm),
        coordinate: geo.toCoordinate(entry?.coordinate)
      }))
      .filter(entry => entry.coordinate && entry.km > 0)
  };
}

/* ----------------------------------------------------------------- listing */

/** A compact, list-card-sized version of a plan. */
function summarisePlan(plan) {
  const source = plan || {};
  return {
    ok: Boolean(source.ok),
    mode: source.mode || FULL_ROUTE,
    reason: clean(source.reason, 60),
    message: clean(source.message, 240),
    riderKm: roundKm(source.riderKm),
    totalKm: roundKm(source.totalKm),
    fraction: Math.round(num(source.fraction, 0) * 10000) / 10000,
    board: source.board || null,
    drop: source.drop || null,
    pickupDetourKm: roundKm(source.pickupDetourKm),
    dropDetourKm: roundKm(source.dropDetourKm),
    estimated: Boolean(source.estimated),
    provider: clean(source.provider, 40),
    // Only a successful partial join has checkpoints worth showing; a rejected
    // plan has no leg, and inventing an empty list would suggest otherwise.
    checkpoints: source.ok && source.mode !== FULL_ROUTE ? planCheckpoints(source) : null
  };
}

/** The public shape of a ride's route, for the map endpoints. */
function routeSummary(ride = {}) {
  const { coordinates, provider, estimated } = resolveRoute(ride);
  const measured = coordinates ? geo.measureLine(coordinates) : null;
  return {
    id: clean(ride._id || ride.id, 40),
    from: clean(ride.from, 120),
    to: clean(ride.to, 120),
    provider,
    estimated: Boolean(estimated),
    geometry: coordinates || [],
    distanceKm: roundKm(measured ? measured.totalKm : num(ride.routeDistanceKm, 0)),
    durationMin: Math.max(0, Math.trunc(num(ride.routeDurationMin, 0))),
    via: Array.isArray(ride.routeVia)
      ? ride.routeVia.map(entry => ({
        name: clean(entry?.name, 120),
        alongKm: roundKm(entry?.alongKm),
        coordinate: geo.toCoordinate(entry?.coordinate)
      })).filter(entry => entry.name)
      : [],
    origin: geo.toCoordinate(ride.routeOrigin),
    destination: geo.toCoordinate(ride.routeDestination),
    // The towns and the 50 km marks for the WHOLE road, so the Find Ride map and
    // the offer preview can label the rider's own journey the same way a joined
    // leg is labelled. `checkpoints` here is the whole-road shape; the partial
    // one comes from planCheckpoints.
    checkpoints: {
      towns: Array.isArray(ride.routeVia)
        ? ride.routeVia.map(entry => ({
          name: clean(entry?.name, 120),
          fromBoardKm: roundKm(entry?.alongKm),
          coordinate: geo.toCoordinate(entry?.coordinate)
        })).filter(entry => entry.name && entry.coordinate)
        : [],
      // The endpoints are the rider's own two places, not towns passed through,
      // so they are left out of the count the UI shows.
      townsBetween: null,
      distances: coordinates
        ? geo.distanceCheckpoints(coordinates, { everyKm: CHECKPOINT_EVERY_KM })
        : []
    },
    computedAt: ride.routeComputedAt || null,
    error: clean(ride.routeError, 240)
  };
}

/**
 * A human sentence for the route, used on the card and the details screen:
 * "Junagadh to Ahmedabad, 415 km, about 6 h 20 m, via Rajkot".
 */
function describeRoute(ride = {}, planned) {
  const summary = planned || routeSummary(ride);
  if (!summary.geometry || summary.geometry.length < 2) return '';
  const hours = Math.floor(summary.durationMin / 60);
  const minutes = summary.durationMin % 60;
  const duration = hours
    ? (minutes ? `${hours} h ${minutes} m` : `${hours} h`)
    : (minutes ? `${minutes} m` : '');
  const via = (summary.via || []).map(entry => entry.name);
  const parts = [`${summary.distanceKm} km`];
  if (duration) parts.push(`about ${duration}`);
  if (via.length) parts.push(`via ${via.join(', ')}`);
  return `${summary.from} to ${summary.to}, ${parts.join(', ')}`;
}

module.exports = {
  FULL_ROUTE,
  PARTIAL_ROUTE,
  PIN_JOIN,
  resolveRoute,
  routeEndpoints,
  buildRoutePlan,
  planQuote,
  partialFarePerSeat,
  partialAdditionalCharges,
  summarisePlan,
  planCheckpoints,
  routeSummary,
  describeRoute,
  placeKey,
  roundKm
};

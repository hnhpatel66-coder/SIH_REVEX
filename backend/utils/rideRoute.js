/**
 * RIDE ROUTE PERSISTENCE  (backend/utils/rideRoute.js)
 *
 * One ride's road lives in eight optional fields on the Ride document. This is
 * the only code that writes them, and it is shared by the two places that need
 * it: the create/patch endpoints, and scripts/backfill-ride-routes.js for offers
 * that were published before routes existed. One writer means the two can never
 * drift into producing differently shaped documents.
 *
 * It lives in its own file rather than in routes/rides.js so a maintenance
 * script can use it without loading the Express router and its middleware.
 *
 * IT NEVER THROWS. A ride offer is the owner doing something real - picking a
 * time, a vehicle and a price - and losing that to a routing outage, a rate
 * limit or a typo in a town name would be a serious regression. Every failure
 * is recorded in `routeError` for the owner to see, and the ride is still
 * created, still approved and still bookable; it simply has no road, which the
 * UI reports honestly instead of drawing a straight line and calling it a map.
 */
'use strict';

const mapbox = require('./mapbox');

/**
 * Fills in a ride's road fields, saving the document either way.
 *
 * @param {import('mongoose').Document} ride  a Ride document, not yet saved
 * @returns {Promise<{ok: boolean, provider?: string, distanceKm?: number, error?: string, note?: string}>}
 */
async function computeAndStoreRoute(ride) {
  try {
    const result = await mapbox.buildRoute({ from: ride.from, to: ride.to });
    if (!result.ok) {
      ride.routeError = String(result.error || 'The road route could not be calculated.').slice(0, 300);
      ride.routeProvider = '';
      ride.routeComputedAt = new Date();
      await ride.save();
      return { ok: false, error: ride.routeError };
    }
    ride.routeOrigin = result.origin;
    ride.routeDestination = result.destination;
    ride.routeGeometry = result.coordinates;
    ride.routeDistanceKm = result.distanceKm;
    ride.routeDurationMin = result.durationMin;
    ride.routeVia = result.via;
    ride.routeProvider = result.provider;
    ride.routeComputedAt = new Date();
    ride.routeError = '';
    // `routeGeometry` is `select: false` in the model, so it must be assigned on
    // the loaded document and saved rather than patched around the projection.
    await ride.save();
    return { ok: true, provider: result.provider, distanceKm: result.distanceKm, note: result.note };
  } catch (error) {
    // An unreachable routing provider must not take the ride down with it.
    console.warn('[rideRoute] route computation failed:', error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = { computeAndStoreRoute };

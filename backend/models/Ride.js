const mongoose = require('mongoose');

/**
 * A ride offer created by an OWNER.
 *
 * Two independent approval systems touch this collection and must never be
 * merged:
 *   1. ADMIN approves the ride offer  -> status: pending | approved | rejected
 *   2. an owner approves a USER's seat booking -> stored on RideBooking, not here
 *
 * Every field added in 1.3 is optional and defaulted, so documents created by
 * earlier versions load without migration. `seatsBooked` is a denormalised
 * counter used for a single guarded atomic UPDATE, which is what actually
 * prevents overbooking under concurrency.
 */
const rideSchema = new mongoose.Schema({
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  driver: { type: String, required: true },
  driverPhone: { type: String, trim: true, default: '' },
  from: { type: String, required: true, trim: true, index: true },
  to: { type: String, required: true, trim: true, index: true },
  date: { type: Date, required: true },
  time: { type: String, required: true },
  seats: { type: Number, required: true, min: 1, max: 6 },
  // Seats consumed by active (payment_pending / pending_owner / confirmed /
  // completed) bookings. Guarded by an atomic $expr update in the book route.
  seatsBooked: { type: Number, default: 0, min: 0 },
  price: { type: Number, required: true, min: 1 },
  // Optional ride pricing extras. `price` stays the fare per seat so every
  // existing record and client keeps working.
  additionalCharges: { type: Number, default: 0, min: 0, max: 100000 },
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  distanceKm: { type: Number, default: 0, min: 0, max: 100000 },
  rating: { type: Number, default: 5, min: 0, max: 5 },
  vehicle: { type: String, required: true },
  vehicleType: { type: String, enum: ['Bike', 'Scooter', 'Car', 'Other'], default: 'Car' },
  fuelType: { type: String, enum: ['Petrol', 'Diesel', 'Electric', 'CNG', 'Hybrid'], default: 'Petrol' },
  numberPlate: { type: String, trim: true, default: '' },
  // When the offer is created from a registered vehicle the SAME image is used
  // that Rent Vehicle shows. There is no second image system.
  vehicleImage: { type: String, default: '' },
  // Reference to the registered vehicle, so the offer, its image and its
  // documents all point at one record.
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null, index: true },
  vehicleAvailability: { type: String, enum: ['rent', 'ride', 'both', 'unavailable'], default: 'ride' },
  notes: { type: String, trim: true, maxlength: 1000, default: '' },
  pickupPoint: { type: String, trim: true, maxlength: 300, default: '' },
  verified: { type: Boolean, default: false },
  status: {
    type: String,
    // `available` is the pre-1.0 name for an approved ride and is still accepted.
    enum: ['available', 'pending', 'approved', 'rejected', 'removed', 'cancelled', 'active', 'completed'],
    default: 'pending'
  },
  rejectionReason: { type: String, trim: true, maxlength: 1000, default: '' },
  removalReason: { type: String, trim: true, maxlength: 1000, default: '' },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  submittedAt: { type: Date, default: Date.now },

  /* ------------------------------------------------------------ Smart Route */
  // The ride's REAL driving road, so a rider searching a place in the middle of
  // it can join midway instead of being told the ride does not go there.
  //
  // Every field below is optional and defaulted, which is what lets a ride
  // created before 1.4 load with no migration: it simply has no geometry, and
  // the matcher falls back to estimating a line between its two towns.
  //
  // `routeGeometry` is GeoJSON order: [[longitude, latitude], ...]. It is
  // deselected in listings (see serializeRides) because it can hold a few
  // hundred points, which would otherwise bloat every Find Ride response.
  routeOrigin: { type: [Number], default: null },
  routeDestination: { type: [Number], default: null },
  routeGeometry: { type: [[Number]], default: undefined, select: false },
  routeDistanceKm: { type: Number, default: 0, min: 0, max: 100000 },
  routeDurationMin: { type: Number, default: 0, min: 0, max: 10000 },
  // [{ name, coordinate, alongKm }] - the towns the road actually passes through,
  // in order. This is what makes a route read "Junagadh to Ahmedabad via Rajkot".
  routeVia: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
  // 'mapbox' | 'osrm' | 'estimate'. Never guess: the UI shows the label this
  // produces, so an estimate is never presented as real road data.
  routeProvider: { type: String, default: '', maxlength: 40 },
  routeComputedAt: { type: Date, default: null },
  // Why no geometry exists. Surfaced on the ride's own screen so a blank route
  // is explained rather than looking broken.
  routeError: { type: String, default: '', maxlength: 300 }
}, { timestamps: true });

rideSchema.index({ status: 1, date: 1 });
rideSchema.index({ driverId: 1, status: 1 });
rideSchema.index({ from: 'text', to: 'text', vehicle: 'text' });

module.exports = mongoose.model('Ride', rideSchema);

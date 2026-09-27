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
  submittedAt: { type: Date, default: Date.now }
}, { timestamps: true });

rideSchema.index({ status: 1, date: 1 });
rideSchema.index({ driverId: 1, status: 1 });
rideSchema.index({ from: 'text', to: 'text', vehicle: 'text' });

module.exports = mongoose.model('Ride', rideSchema);

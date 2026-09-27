const mongoose = require('mongoose');

/**
 * A USER's seat reservation on a ride offer.
 *
 * Flow (kept strictly separate from the rental booking flow):
 *   Find Ride -> select seats -> accept terms -> PAY (Razorpay) -> the booking
 *   becomes `pending_owner` -> the OWNER approves or rejects.
 *
 * Nothing here is ever hard-deleted on cancellation: the status plus the
 * `cancellation` sub-document is the audit trail.
 */
const cancellationSchema = new mongoose.Schema({
  cancelledBy: { type: String, enum: ['user', 'owner', 'admin', ''], default: '' },
  cancelledById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reason: { type: String, trim: true, maxlength: 500, default: '' },
  cancelledAt: { type: Date, default: null },
  originalAmount: { type: Number, default: 0, min: 0 },
  cancellationFee: { type: Number, default: 0, min: 0 },
  cancellationFeePercent: { type: Number, default: 0, min: 0, max: 100 },
  refundAmount: { type: Number, default: 0, min: 0 },
  finalAmount: { type: Number, default: 0, min: 0 },
  platformFee: { type: Number, default: 0, min: 0 },
  withinFreeWindow: { type: Boolean, default: false },
  policyVersion: { type: String, default: '' },
  explanation: { type: String, default: '' }
}, { _id: false });

const rideBookingSchema = new mongoose.Schema({
  rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  seats: { type: Number, required: true, min: 1, max: 6 },
  totalAmount: { type: Number, required: true, min: 0 },
  // Full backend-calculated quote, stored so the booking history keeps showing
  // exactly what was charged even if the ride is later edited.
  quote: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Copy of the ride at booking time. The vehicle photo travels with the
  // booking, which is why it never disappears from history or from the
  // owner's request screen.
  rideSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null },
  vehicleImage: { type: String, default: '' },
  paymentMethod: { type: String, default: 'razorpay' },
  razorpayOrderId: { type: String, sparse: true, index: true },
  razorpayPaymentId: { type: String, sparse: true, index: true },
  razorpaySignature: { type: String },
  paymentReference: { type: String, sparse: true, index: true },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded', 'partially_refunded'], default: 'pending' },
  paidAmount: { type: Number, default: 0, min: 0 },
  refund: {
    id: { type: String, default: '' },
    amount: { type: Number, default: 0, min: 0 },
    status: { type: String, default: '' },
    processedAt: { type: Date, default: null },
    note: { type: String, default: '' }
  },
  status: {
    type: String,
    // `cancelled` is the legacy umbrella value and is still accepted.
    enum: [
      'payment_pending', 'pending_owner', 'confirmed', 'approved', 'rejected', 'completed',
      'cancelled', 'cancelled_by_user', 'cancelled_by_owner', 'cancelled_by_admin'
    ],
    default: 'payment_pending'
  },
  termsAccepted: { type: Boolean, default: false },
  termsAcceptedAt: { type: Date, default: null },
  ownerDecision: {
    decision: { type: String, enum: ['approved', 'rejected', ''], default: '' },
    reason: { type: String, trim: true, maxlength: 1000, default: '' },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  cancellation: { type: cancellationSchema, default: () => ({}) },
  rating: { type: Number, min: 1, max: 5 },
  comment: { type: String, trim: true, maxlength: 500 }
}, { timestamps: true });

rideBookingSchema.index({ rideId: 1, status: 1 });
rideBookingSchema.index({ userId: 1, createdAt: -1 });
// One live seat-holding booking per rider per ride.
rideBookingSchema.index(
  { rideId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['payment_pending', 'pending_owner', 'confirmed'] } }, name: 'active_ride_booking_unique' }
);

module.exports = mongoose.model('RideBooking', rideBookingSchema);

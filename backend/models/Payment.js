const mongoose = require('mongoose');

/**
 * Payment ledger.
 *
 * 1.3 adds ride payments. `bookingId`/`vehicleId` are no longer required because
 * a ride payment has neither; they stay indexed so every existing query against
 * rental payments keeps working unchanged.
 */
const paymentSchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null, index: true },
  rideBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'RideBooking', default: null, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null, index: true },
  kind: { type: String, enum: ['rental', 'ride', 'refund', ''], default: 'rental' },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR' },
  method: { type: String, enum: ['demo', 'razorpay'], default: 'demo' },
  status: { type: String, enum: ['created', 'paid', 'failed', 'refunded', 'partially_refunded'], default: 'created' },
  reference: { type: String, required: true, unique: true, index: true },
  providerData: { type: mongoose.Schema.Types.Mixed, default: {} },
  paidAt: { type: Date, default: null },
  refundedAt: { type: Date, default: null },
  refundAmount: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

paymentSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Payment', paymentSchema);

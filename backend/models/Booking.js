const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  estimatedKm: { type: Number, default: 0, min: 0, max: 100000 },
  panNumber: { type: String, trim: true, default: '' },
  drivingLicenseNumber: { type: String, trim: true, default: '' },
  paymentMethod: { type: String, enum: ['demo', 'razorpay'], default: 'demo' },
  paymentReference: { type: String, index: true, sparse: true },
  hours: { type: Number, required: true, min: 1 },
  price: { type: Number, default: 0, min: 0 },
  priceUnit: { type: String, enum: ['hour', 'day', 'km'], default: 'hour' },
  billableUnits: { type: Number, default: 1, min: 1 },
  includedKm: { type: Number, default: 300, min: 0 },
  baseAmount: { type: Number, default: 0, min: 0 },
  extraKm: { type: Number, default: 0, min: 0 },
  extraKmRate: { type: Number, default: 0, min: 0 },
  extraKilometerCharges: { type: Number, default: 0, min: 0 },
  additionalCharges: { type: Number, default: 0, min: 0 },
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  discountAmount: { type: Number, default: 0, min: 0 },
  discountedSubtotal: { type: Number, default: 0, min: 0 },
  taxPercent: { type: Number, default: 0, min: 0, max: 100 },
  taxFees: { type: Number, default: 0, min: 0 },
  subtotal: { type: Number, default: 0, min: 0 },
  grandTotal: { type: Number, default: 0, min: 0 },
  // totalAmount is retained as the compatibility alias used by existing clients.
  totalAmount: { type: Number, required: true, min: 0 },
  paidAmount: { type: Number, default: 0, min: 0 },
  remainingAmount: { type: Number, default: 0, min: 0 },
  pricingSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  monthKey: { type: String, index: true },
  monthlySlot: { type: Number, min: 1, max: 2 },
  razorpayOrderId: { type: String, index: true, sparse: true },
  razorpayPaymentId: { type: String, index: true, sparse: true },
  razorpaySignature: { type: String },
  status: {
    type: String,
    enum: ['pending', 'payment_pending', 'pending_owner', 'confirmed', 'approved', 'rejected', 'cancelled', 'completed'],
    default: 'payment_pending'
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded'],
    default: 'pending'
  },
  agreementAcceptedAt: { type: Date, default: null },
  ownerDecision: {
    decision: { type: String, enum: ['approved', 'rejected', ''], default: '' },
    reason: { type: String, trim: true, maxlength: 1000, default: '' },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  rating: { type: Number, min: 1, max: 5 },
  comment: { type: String, trim: true, maxlength: 500 }
}, { timestamps: true });

bookingSchema.index(
  { userId: 1, monthKey: 1, monthlySlot: 1 },
  { unique: true, name: 'active_booking_slot_unique', partialFilterExpression: { monthlySlot: { $type: 'number' } } }
);
bookingSchema.index({ vehicleId: 1, status: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('Booking', bookingSchema);

const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  estimatedKm: { type: Number, default: 0, min: 0 },
  panNumber: { type: String, trim: true },
  drivingLicenseNumber: { type: String, trim: true },
  paymentMethod: { type: String, enum: ['demo', 'razorpay'], default: 'demo' },
  paymentReference: { type: String, index: true, sparse: true },
  hours: { type: Number, required: true, min: 1 },
  totalAmount: { type: Number, required: true, min: 0 },
  monthKey: { type: String, index: true },
  monthlySlot: { type: Number, min: 1, max: 2 },
  razorpayOrderId: { type: String, index: true, sparse: true },
  razorpayPaymentId: { type: String, index: true, sparse: true },
  razorpaySignature: { type: String },
  status: {
    type: String,
    enum: ['pending', 'payment_pending', 'confirmed', 'cancelled', 'completed'],
    default: 'payment_pending'
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed'],
    default: 'pending'
  },
  rating: { type: Number, min: 1, max: 5 },  // NEW: Feedback rating
  comment: { type: String, trim: true, maxlength: 500 }  // NEW: Feedback comment
}, { timestamps: true });

bookingSchema.index(
  { userId: 1, monthKey: 1, monthlySlot: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model('Booking', bookingSchema);

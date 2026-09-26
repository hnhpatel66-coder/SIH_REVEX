const mongoose = require('mongoose');

const rideBookingSchema = new mongoose.Schema({
  rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  seats: { type: Number, required: true, min: 1, max: 6 },
  totalAmount: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, default: 'razorpay' },
  razorpayOrderId: { type: String, sparse: true, index: true },
  razorpayPaymentId: { type: String, sparse: true, index: true },
  razorpaySignature: { type: String },
  paymentReference: { type: String, sparse: true, index: true },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
  status: { type: String, enum: ['payment_pending', 'confirmed', 'cancelled', 'completed'], default: 'payment_pending' },
  rating: { type: Number, min: 1, max: 5 },
  comment: { type: String, trim: true, maxlength: 500 }
}, { timestamps: true });

module.exports = mongoose.model('RideBooking', rideBookingSchema);

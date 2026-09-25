const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR' },
  method: { type: String, enum: ['demo', 'razorpay'], default: 'demo' },
  status: { type: String, enum: ['created', 'paid', 'failed', 'refunded'], default: 'created' },
  reference: { type: String, required: true, unique: true, index: true },
  providerData: { type: mongoose.Schema.Types.Mixed, default: {} },
  paidAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);

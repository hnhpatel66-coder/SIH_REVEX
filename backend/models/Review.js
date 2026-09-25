const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  rating: { type: Number, min: 1, max: 5, required: true },
  comment: { type: String, trim: true, maxlength: 500 }
}, { timestamps: true });

reviewSchema.index({ bookingId: 1 }, { unique: true, sparse: true });
reviewSchema.index({ vehicleId: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);

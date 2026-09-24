const mongoose = require('mongoose');

const monthlyBookingCounterSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  monthKey: { type: String, required: true },
  count: { type: Number, default: 0, min: 0, max: 2 }
}, { timestamps: true });

monthlyBookingCounterSchema.index({ userId: 1, monthKey: 1 }, { unique: true });

module.exports = mongoose.model('MonthlyBookingCounter', monthlyBookingCounterSchema);

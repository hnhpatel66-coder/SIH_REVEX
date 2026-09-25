const mongoose = require('mongoose');

const rideSchema = new mongoose.Schema({
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  driver: { type: String, required: true },
  driverPhone: { type: String, trim: true, default: '' },
  from: { type: String, required: true, trim: true, index: true },
  to: { type: String, required: true, trim: true, index: true },
  date: { type: Date, required: true },
  time: { type: String, required: true },
  seats: { type: Number, required: true, min: 1, max: 6 },
  price: { type: Number, required: true, min: 1 },
  rating: { type: Number, default: 5, min: 0, max: 5 },
  vehicle: { type: String, required: true },
  vehicleType: { type: String, enum: ['Bike', 'Scooter', 'Car', 'Other'], default: 'Car' },
  fuelType: { type: String, enum: ['Petrol', 'Diesel', 'Electric', 'CNG', 'Hybrid'], default: 'Petrol' },
  numberPlate: { type: String, trim: true, default: '' },
  vehicleImage: { type: String, default: '' },
  verified: { type: Boolean, default: false },
  status: { type: String, enum: ['available', 'pending', 'approved', 'rejected', 'removed', 'cancelled'], default: 'pending' },
  rejectionReason: { type: String, trim: true, maxlength: 1000, default: '' },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

module.exports = mongoose.model('Ride', rideSchema);

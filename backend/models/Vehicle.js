const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['Bike', 'Scooter', 'Car'], required: true },
  location: { type: String, required: true, trim: true, index: true },
  price: { type: Number, required: true, min: 1 },
  availableFrom: { type: Date },
  numberPlate: { type: String, trim: true },
  ownershipPaper: String,
  insurance: String,
  puc: String,
  vehiclePicture: String,
  image: String,
  rating: { type: Number, default: 5 },
  status: { type: String, enum: ['available', 'pending', 'unavailable'], default: 'available' },
  verified: { type: Boolean, default: false },
  // Owner earnings tracking
  totalEarnings: { type: Number, default: 0 },
  totalRentals: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Vehicle', vehicleSchema);

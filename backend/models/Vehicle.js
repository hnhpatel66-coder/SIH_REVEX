const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema({
  type: { type: String, enum: ['ownership', 'insurance', 'puc', 'id', 'other'], required: true },
  label: { type: String, trim: true, default: '' },
  fileName: { type: String, trim: true, default: '' },
  mimeType: { type: String, trim: true, default: '' },
  dataUrl: { type: String, default: '' },
  size: { type: Number, min: 0, default: 0 },
  status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
  uploadedAt: { type: Date, default: Date.now }
}, { _id: true });

const vehicleSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  category: { type: String, enum: ['Car', 'Bike', 'Scooter', 'Other'], default: 'Other', index: true },
  // `type` is retained for compatibility with existing records and clients.
  type: { type: String, enum: ['Bike', 'Scooter', 'Car', 'Other'], default: 'Other' },
  brand: { type: String, trim: true, maxlength: 80, default: '' },
  model: { type: String, trim: true, maxlength: 80, default: '' },
  location: { type: String, required: true, trim: true, maxlength: 200, index: true },
  description: { type: String, trim: true, maxlength: 2000, default: '' },
  fuelType: { type: String, enum: ['Petrol', 'Diesel', 'Electric', 'CNG', 'Hybrid'], default: 'Petrol', index: true },
  transmission: { type: String, enum: ['Manual', 'Automatic', 'Other'], default: 'Manual' },
  price: { type: Number, required: true, min: 1 },
  priceUnit: { type: String, enum: ['hour', 'day', 'km'], default: 'hour' },
  currentKm: { type: Number, default: 0, min: 0, max: 70000 },
  includedKm: { type: Number, default: 300, min: 0, max: 100000 },
  extraKmRate: { type: Number, default: 10, min: 0, max: 10000 },
  additionalCharges: { type: Number, default: 0, min: 0, max: 1000000 },
<<<<<<< HEAD
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
=======
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  taxPercent: { type: Number, default: 0, min: 0, max: 100 },
  availableFrom: { type: Date },
  availability: { type: String, enum: ['available', 'unavailable'], default: 'available' },
  numberPlate: { type: String, trim: true, maxlength: 24, default: '' },
  numberPlateNormalized: { type: String, trim: true, maxlength: 24, default: undefined },
  ownershipPaper: { type: String, default: '' },
  insurance: { type: String, default: '' },
  puc: { type: String, default: '' },
  documents: { type: [documentSchema], default: [] },
  vehiclePicture: { type: String, default: '' },
  image: { type: String, default: '' },
  rating: { type: Number, default: 5, min: 0, max: 5 },
  reviewCount: { type: Number, default: 0, min: 0 },
  // status is the moderation state. Legacy available/unavailable values remain
  // accepted during migration and are normalized by the API.
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'removed', 'available', 'unavailable'], default: 'pending', index: true },
  verified: { type: Boolean, default: false },
  rejectionReason: { type: String, trim: true, maxlength: 1000, default: '' },
  removalReason: { type: String, trim: true, maxlength: 1000, default: '' },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  removedAt: { type: Date, default: null },
  totalEarnings: { type: Number, default: 0, min: 0 },
  totalRentals: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

// Existing legacy records may have blank plates. New normalized values are
// unique, while the API also performs a friendly duplicate check for old data.
vehicleSchema.index({ numberPlateNormalized: 1 }, { unique: true, sparse: true });
vehicleSchema.index({ status: 1, category: 1, createdAt: -1 });
vehicleSchema.index({ name: 'text', brand: 'text', model: 'text', location: 'text' });

module.exports = mongoose.model('Vehicle', vehicleSchema);

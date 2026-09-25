const mongoose = require('mongoose');

const agreementSchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true, index: true },
  agreementId: { type: String, required: true, unique: true, index: true },
  renterName: { type: String, required: true },
  renterEmail: { type: String, required: true },
  renterPhone: { type: String, default: '' },
  ownerName: { type: String, required: true },
  ownerEmail: { type: String, required: true },
  ownerPhone: { type: String, default: '' },
  vehicleName: { type: String, required: true },
  vehicleType: { type: String, default: '' },
  vehicleCategory: { type: String, default: '' },
  vehicleFuelType: { type: String, default: '' },
  vehicleLocation: { type: String, default: '' },
  vehicleNumberPlate: { type: String, default: '' },
  pickupDate: { type: Date, required: true },
  returnDate: { type: Date, required: true },
  pickupLocation: { type: String, default: '' },
  returnLocation: { type: String, default: '' },
  hours: { type: Number, default: 0, min: 0 },
  estimatedKm: { type: Number, default: 0, min: 0 },
  rentalAmount: { type: Number, required: true, min: 0 },
  baseAmount: { type: Number, default: 0, min: 0 },
  additionalCharges: { type: Number, default: 0, min: 0 },
<<<<<<< HEAD
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  discountAmount: { type: Number, default: 0, min: 0 },
=======
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  extraKilometerCharges: { type: Number, default: 0, min: 0 },
  taxFees: { type: Number, default: 0, min: 0 },
  grandTotal: { type: Number, default: 0, min: 0 },
  pricingSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  paymentStatus: { type: String, enum: ['PENDING', 'PAID', 'FAILED', 'REFUNDED'], default: 'PENDING' },
  agreementStatus: { type: String, enum: ['pending_user', 'pending_owner', 'approved', 'rejected'], default: 'pending_user' },
  acceptedByUser: { type: Boolean, default: false },
  acceptedAt: { type: Date, default: null },
  acceptedByOwner: { type: Boolean, default: false },
  ownerAcceptedAt: { type: Date, default: null },
  termsVersion: { type: String, default: 'revex-v3' },
  termsSnapshot: { type: [String], default: [] },
  ownerDecisionReason: { type: String, trim: true, maxlength: 1000, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Agreement', agreementSchema);

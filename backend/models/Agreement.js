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
  vehicleLocation: { type: String, default: '' },
  vehicleNumberPlate: { type: String, default: '' },
  pickupDate: { type: Date, required: true },
  returnDate: { type: Date, required: true },
  pickupLocation: { type: String, default: '' },
  returnLocation: { type: String, default: '' },
  hours: { type: Number, default: 0 },
  estimatedKm: { type: Number, default: 0 },
  rentalAmount: { type: Number, required: true },
  paymentStatus: { type: String, default: 'PAID' },
  acceptedByUser: { type: Boolean, default: true },
  acceptedAt: { type: Date, default: Date.now },
  acceptedByOwner: { type: Boolean, default: false },
  ownerAcceptedAt: { type: Date },
  termsVersion: { type: String, default: 'revex-v2' }
}, { timestamps: true });

module.exports = mongoose.model('Agreement', agreementSchema);

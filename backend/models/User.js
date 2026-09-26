const mongoose = require('mongoose');

/**
 * A user account: rider, owner or admin.
 *
 * `photo` is an optional profile picture stored as a data URL, exactly like the
 * vehicle picture, so there is ONE image mechanism in REVEX. It is optional and
 * defaulted, so existing records load unchanged and the UI falls back to
 * initials when nobody has uploaded one.
 */
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true, default: '' },
  photo: { type: String, default: '' },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['user', 'owner', 'admin'], default: 'user' },
  isVerified: { type: Boolean, default: false },
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null },
  ownerEarnings: { type: Number, default: 0, min: 0 },
  // Split revenue counters: the admin Owner Summary reports rental and ride
  // income separately instead of guessing from a single blended number.
  ownerRideEarnings: { type: Number, default: 0, min: 0 },
  ownerRentalEarnings: { type: Number, default: 0, min: 0 },
  ownerCommissionPaid: { type: Number, default: 0, min: 0 },
  // Driver rating aggregated from confirmed/completed ride bookings.
  rating: { type: Number, default: 5, min: 0, max: 5 },
  ratingCount: { type: Number, default: 0, min: 0 },
  totalCarsOnRent: { type: Number, default: 0, min: 0 },
  carApprovalStatus: { type: String, enum: ['pending', 'approved', 'rejected', 'removed'], default: 'pending' },
  isActive: { type: Boolean, default: true },
  deactivatedAt: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null }
}, { timestamps: true });

userSchema.index({ role: 1, createdAt: -1 });

module.exports = mongoose.model('User', userSchema);

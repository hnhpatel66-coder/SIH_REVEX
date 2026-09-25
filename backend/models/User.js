const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true, default: '' },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['user', 'owner', 'admin'], default: 'user' },
  isVerified: { type: Boolean, default: false },
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null },
  ownerEarnings: { type: Number, default: 0, min: 0 },
  totalCarsOnRent: { type: Number, default: 0, min: 0 },
  carApprovalStatus: { type: String, enum: ['pending', 'approved', 'rejected', 'removed'], default: 'pending' },
  isActive: { type: Boolean, default: true },
  deactivatedAt: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null }
}, { timestamps: true });

userSchema.index({ role: 1, createdAt: -1 });

module.exports = mongoose.model('User', userSchema);

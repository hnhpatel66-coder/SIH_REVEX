const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function publicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    role: user.role,
    isVerified: user.isVerified,
    ownerEarnings: user.ownerEarnings || 0,
    totalCarsOnRent: user.totalCarsOnRent || 0,
    carApprovalStatus: user.carApprovalStatus || 'pending'
  };
}

function signToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const exists = await User.findOne({ email: normalizedEmail });
    if (exists) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const safeRole = role === 'owner' ? 'owner' : 'user';

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: phone || '',
      passwordHash,
      role: safeRole
    });

    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: 'An account with this email already exists.' });
    res.status(500).json({ message: 'Registration failed. Please check the form and try again.' });
  }
});

/* Forgot password - generate reset token. Generic message avoids email enumeration. */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required.' });
    }
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.json({ message: 'If an account with that email exists, a reset link has been sent.' });
    }
    const crypto = require('crypto');
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour expiry
    await user.save();
    // A mail provider can be added without changing the API. Never expose a
    // reset token in production; the local demo opt-in is explicit.
    const demoResetEnabled = process.env.NODE_ENV !== 'production' && process.env.ENABLE_DEMO_RESET === 'true';
    res.json({
      message: 'If an account with that email exists, a reset link has been sent.',
      ...(demoResetEnabled ? { resetToken, resetLink: `reset-password.html?token=${resetToken}` } : {})
    });
  } catch (e) {
    res.status(500).json({ message: 'Failed to generate reset token.' });
  }
});

/* NEW: Reset password with token */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword, password } = req.body;
    const pwd = newPassword || password;
    if (!token || !pwd) {
      return res.status(400).json({ message: 'Token and new password are required.' });
    }
    if (String(pwd).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });
    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired reset token.' });
    }
    const passwordHash = await bcrypt.hash(pwd, 10);
    user.passwordHash = passwordHash;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();
    res.json({ message: 'Password has been reset successfully.' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to reset password.' });
  }
});

/* Switch role - any registered user can become an owner, owner can switch back to user */
router.post('/switch-role', requireAuth, async (req, res) => {
  try {
    const { newRole } = req.body;
    if (!newRole || !['user', 'owner'].includes(newRole)) {
      return res.status(400).json({ message: 'Valid role is required (user or owner).' });
    }
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    if (user.role === 'admin') {
      return res.status(403).json({ message: 'Admin role cannot be changed here.' });
    }
    if (user.role === newRole) {
      return res.status(400).json({ message: `You are already a ${newRole}.` });
    }
    user.role = newRole;
    await user.save();
    res.json({ token: signToken(user), user: publicUser(user), message: `Role switched to ${newRole} successfully.` });
  } catch (e) {
    res.status(500).json({ message: 'Failed to switch role.' });
  }
});

/* Edit profile - update name and phone, returns fresh user + token */
router.post('/edit-profile', requireAuth, async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'Name is required.' });
    }
    if (phone !== undefined && phone !== '' && !/^[+\d][\d\s-]{5,18}$/.test(String(phone).trim())) {
      return res.status(400).json({ message: 'Enter a valid phone number.' });
    }
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    user.name = String(name).trim();
    if (phone !== undefined) user.phone = String(phone).trim();
    await user.save();
    res.json({ token: signToken(user), user: publicUser(user), message: 'Profile updated successfully.' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to update profile.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { userId, email, password } = req.body;
    const login = (email || userId || '').trim().toLowerCase();

    if (!login || !password) {
      return res.status(400).json({ message: 'Email/User ID and password are required.' });
    }

    let user = await User.findOne({ email: login });
    if (!user && /^[a-f0-9]{24}$/i.test(login)) user = await User.findById(login);

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: 'Invalid login details.' });
    }
    if (user.isActive === false) {
      return res.status(403).json({ message: 'This account has been deactivated. Contact support.' });
    }

    user.lastLoginAt = new Date();
    await user.save();
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ message: 'Login failed. Please try again.' });
  }
});

/*
  Secure first-admin setup:
  - ADMIN_SETUP_KEY lives only in backend/.env
  - Public registration can NEVER create an admin
  - Setup works only when no admin exists
*/
router.post('/setup-admin', async (req, res) => {
  try {
    if (!process.env.ADMIN_SETUP_KEY) {
      return res.status(503).json({ message: 'Admin setup is not configured on the server.' });
    }

    const adminExists = await User.exists({ role: 'admin' });
    if (adminExists) {
      return res.status(409).json({ message: 'An admin account already exists. Use the admin login.' });
    }

    const { setupKey, name, email, phone, password } = req.body;
    if (!setupKey || setupKey !== process.env.ADMIN_SETUP_KEY) {
      return res.status(403).json({ message: 'Invalid admin setup key.' });
    }
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    if (await User.exists({ email: normalizedEmail })) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const admin = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: phone || '',
      passwordHash,
      role: 'admin',
      isVerified: true
    });

    res.status(201).json({ token: signToken(admin), user: publicUser(admin), message: 'Admin account created successfully.' });
  } catch (e) {
    res.status(500).json({ message: 'Admin creation failed. Please try again.' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;

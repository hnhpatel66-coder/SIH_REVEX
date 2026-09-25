const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const rateBuckets = new Map();

// Limits are deliberately strict to blunt credential stuffing. They can be
// raised (or disabled with 0) via AUTH_RATE_LIMIT_MAX for automated test runs
// and for deployments behind a shared NAT, without editing source.
const AUTH_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX || 0) || 0;
function rateLimit(windowMs, max) {
  const effectiveMax = AUTH_LIMIT_MAX > 0 ? AUTH_LIMIT_MAX : max;
  return (req, res, next) => {
    if (AUTH_LIMIT_MAX === 0 && effectiveMax <= 0) return next();
    const key = `${req.ip}:${req.path}`;
    const now = Date.now(); const bucket = rateBuckets.get(key) || { count: 0, started: now };
    if (now - bucket.started > windowMs) { bucket.count = 0; bucket.started = now; }
    bucket.count += 1; rateBuckets.set(key, bucket);
    if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (now - v.started > windowMs) rateBuckets.delete(k);
    if (bucket.count > effectiveMax) return res.status(429).json({ message: 'Too many attempts. Please wait and try again.' });
    next();
  };
}

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

async function deliverResetEmail(user, resetToken) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;
  if (smtpHost && smtpUser && smtpPass && from) {
    try {
      // Optional transport: installed only when SMTP is actually configured.
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({ host: smtpHost, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: { user: smtpUser, pass: smtpPass } });
      await transporter.sendMail({ from, to: user.email, subject: 'Reset your REVEX password', text: `Use this secure link to reset your password: ${process.env.PUBLIC_URL || ''}/reset-password.html?token=${resetToken}` });
      return { sent: true };
    } catch (error) {
      console.error('Password reset email failed:', error.message);
      return { sent: false, error };
    }
  }
  return { sent: false };
}

const READY_STATE = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

router.post('/register', rateLimit(15 * 60 * 1000, 10), async (req, res) => {
  const startedAt = Date.now();
  // Never log credentials: only the shape of the request, never values.
  const trace = (stage, detail = '') => {
    if (process.env.NODE_ENV === 'production') return;
    console.log(`[register] ${stage}${detail ? ` ${detail}` : ''} db=${READY_STATE[mongoose.connection.readyState] || 'unknown'}`);
  };
  try {
    trace('received', `fields=[${Object.keys(req.body || {}).join(',')}]`);
    // A disconnected database must never masquerade as a form validation error.
    if (mongoose.connection.readyState !== 1) {
      trace('rejected', 'database not connected');
      return res.status(503).json({ success: false, code: 'DATABASE_UNAVAILABLE', message: 'Registration is temporarily unavailable. The database is not connected. Please try again shortly.' });
    }
    const { name, email, phone, password, confirmPassword, role } = req.body;
    if (!name || !email || !password) {
      trace('rejected', 'missing required fields');
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Name, email and password are required.' });
    }
    if (confirmPassword !== undefined && String(confirmPassword) !== String(password)) {
      trace('rejected', 'password confirmation mismatch');
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Passwords do not match.' });
    }
    if (String(password).length < 8) {
      trace('rejected', 'password too short');
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      trace('rejected', 'invalid email format');
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Enter a valid email address.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    trace('validation passed');
    const exists = await User.findOne({ email: normalizedEmail });
    if (exists) {
      trace('rejected', 'email already registered');
      return res.status(409).json({ success: false, code: 'EMAIL_EXISTS', message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const safeRole = role === 'owner' ? 'owner' : 'user';
    trace('hashed', `role=${safeRole}`);

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: phone || '',
      passwordHash,
      role: safeRole
    });
    trace('user created', `id=${user._id}`);

    const token = signToken(user);
    trace('jwt issued', `${Date.now() - startedAt}ms`);
    res.status(201).json({ success: true, token, user: publicUser(user) });
  } catch (e) {
    // Never surface a raw driver error to the user; log it for the operator.
    console.error('[register] failed:', e.name, e.message);
    if (e.code === 11000) return res.status(409).json({ success: false, code: 'EMAIL_EXISTS', message: 'An account with this email already exists.' });
    if (e.name === 'ValidationError') return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: e.message });
    if (e.name === 'MongooseServerSelectionError' || e.name === 'MongoNetworkError') {
      return res.status(503).json({ success: false, code: 'DATABASE_UNAVAILABLE', message: 'Registration is temporarily unavailable. Please try again shortly.' });
    }
    res.status(500).json({ success: false, code: 'REGISTRATION_FAILED', message: 'Registration failed. Please try again.' });
  }
});

/* Forgot password - generate reset token. Generic message avoids email enumeration. */
router.post('/forgot-password', rateLimit(15 * 60 * 1000, 8), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required.' });
    }
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    // NOTE: the response is byte-for-byte identical whether or not the account
    // exists and whether or not mail is configured. Returning a different status
    // or message here would turn this endpoint into an email-enumeration oracle.
    const generic = { message: 'If an account with that email exists, a reset link has been sent.' };
    if (!user) {
      return res.json(generic);
    }
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour expiry
    await user.save();
    // A mail provider can be added without changing the API. Never expose a
    // reset token in production; the local demo opt-in is explicit.
    const demoResetEnabled = process.env.NODE_ENV !== 'production' && process.env.ENABLE_DEMO_RESET === 'true';
    const delivery = await deliverResetEmail(user, resetToken);
    if (!delivery.sent && !demoResetEnabled) {
      // Misconfiguration is an operator problem, surfaced in the server log --
      // never in the HTTP response, which would leak account existence.
      console.warn('Password reset requested but no SMTP transport is configured. Set SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM in .env.');
      return res.json(generic);
    }
    res.json({
      message: 'If an account with that email exists, a reset link has been sent.',
      ...(demoResetEnabled ? { resetToken, resetLink: `reset-password.html?token=${resetToken}` } : {})
    });
  } catch (e) {
    res.status(500).json({ message: 'Failed to generate reset token.' });
  }
});

/* NEW: Reset password with token */
router.post('/reset-password', rateLimit(15 * 60 * 1000, 10), async (req, res) => {
  try {
    const { token, newPassword, password, confirmPassword } = req.body;
    const pwd = newPassword || password;
    if (!token || !pwd) {
      return res.status(400).json({ message: 'Token and new password are required.' });
    }
    if (confirmPassword !== undefined && String(confirmPassword) !== String(pwd)) {
      return res.status(400).json({ message: 'Passwords do not match.' });
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

router.post('/login', rateLimit(15 * 60 * 1000, 20), async (req, res) => {
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
router.post('/setup-admin', rateLimit(60 * 60 * 1000, 5), async (req, res) => {
  try {
    if (!process.env.ADMIN_SETUP_KEY) {
      return res.status(503).json({ message: 'Admin setup is not configured on the server.' });
    }

    const adminExists = await User.exists({ role: 'admin' });
    if (adminExists) {
      return res.status(409).json({ message: 'An admin account already exists. Use the admin login.' });
    }

    const { setupKey, name, email, phone, password } = req.body;
    const expectedKey = String(process.env.ADMIN_SETUP_KEY);
    const providedKey = String(setupKey || '');
    const keyBuffer = Buffer.from(providedKey);
    const expectedBuffer = Buffer.from(expectedKey);
    if (!providedKey || keyBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(keyBuffer, expectedBuffer)) {
      return res.status(403).json({ message: 'Invalid admin setup key.' });
    }
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) return res.status(400).json({ message: 'Enter a valid email address.' });
    if (String(password).length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });

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

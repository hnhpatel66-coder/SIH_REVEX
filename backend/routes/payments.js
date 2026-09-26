const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../middleware/auth');
const Payment = require('../models/Payment');
const gateway = require('../utils/payments');

const router = express.Router();

/**
 * PAYMENT GATEWAY STATUS
 *
 * A single place the UI can ask "can this server take a payment right now, and
 * if not, should I offer the labelled test payment?". The frontend used to
 * decide this from a hard-coded flag in two files, which is how the two screens
 * disagreed.
 *
 * `enabled` only means the two env variables are non-empty. `usable` additionally
 * means Razorpay accepted them — the check that was missing, and the reason a
 * server with a revoked or mistyped key showed a checkout that could never
 * succeed while offering no fallback.
 *
 * The secret key is never returned; only whether it is set.
 */
router.get('/config', async (req, res) => {
  const config = gateway.publicConfig();
  const health = await gateway.checkHealth();
  const labels = {
    ready: 'Razorpay is connected',
    missing: 'Test payment (no gateway configured)',
    rejected: 'Test payment (Razorpay rejected the server keys)',
    unreachable: 'Test payment (Razorpay unreachable)'
  };
  res.json({
    ...config,
    // The client offers a test payment whenever real payments cannot succeed.
    usable: health.usable,
    state: health.state,
    testModeAvailable: !health.usable,
    testModeLabel: labels[health.state] || labels.missing,
    message: health.message
  });
});

/** The signed-in user's own payments, across rental and ride bookings. */
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const payments = await Payment.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100).lean();
    res.json(payments.map(payment => ({
      id: String(payment._id),
      kind: payment.kind,
      flow: payment.kind === 'ride' ? 'ride' : 'rental',
      amount: payment.amount,
      refundAmount: payment.refundAmount || 0,
      currency: payment.currency,
      method: payment.method,
      status: payment.status,
      reference: payment.reference,
      bookingId: payment.bookingId ? String(payment.bookingId) : '',
      rideBookingId: payment.rideBookingId ? String(payment.rideBookingId) : '',
      createdAt: payment.createdAt,
      paidAt: payment.paidAt,
      refundedAt: payment.refundedAt
    })));
  } catch (error) {
    console.error('[payments] mine failed:', error.message);
    res.status(500).json({ message: 'Your payments could not be loaded.' });
  }
});

/** Admin payment ledger, with an optional flow filter. */
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const query = {};
  if (req.query.kind) query.kind = String(req.query.kind);
  if (req.query.method) query.method = String(req.query.method);
  if (req.query.status) query.status = String(req.query.status);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const payments = await Payment.find(query).sort({ createdAt: -1 }).limit(limit).lean();
  const totals = await Payment.aggregate([
    { $match: query },
    { $group: { _id: { kind: '$kind', status: '$status' }, amount: { $sum: '$amount' }, refunds: { $sum: '$refundAmount' }, count: { $sum: 1 } } }
  ]);
  res.json({ payments, totals, gateway: gateway.publicConfig() });
});

/**
 * Receipt for one payment. Scoped to the payer unless the caller is the admin
 * or the owner, so a reference id can never be used to read someone else's
 * payment.
 */
router.get('/:id', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Payment not found.' });
  const payment = await Payment.findById(req.params.id).lean();
  if (!payment) return res.status(404).json({ message: 'Payment not found.' });
  const isOwner = payment.ownerId && String(payment.ownerId) === String(req.user._id);
  if (String(payment.userId) !== String(req.user._id) && !isOwner && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'You cannot view this payment.' });
  }
  res.json({
    id: String(payment._id),
    kind: payment.kind,
    amount: payment.amount,
    refundAmount: payment.refundAmount || 0,
    currency: payment.currency,
    method: payment.method,
    status: payment.status,
    reference: payment.reference,
    bookingId: payment.bookingId ? String(payment.bookingId) : '',
    rideBookingId: payment.rideBookingId ? String(payment.rideBookingId) : '',
    createdAt: payment.createdAt,
    paidAt: payment.paidAt,
    refundedAt: payment.refundedAt
  });
});

module.exports = router;

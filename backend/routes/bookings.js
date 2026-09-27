const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Vehicle = require('../models/Vehicle');
const User = require('../models/User');
const Booking = require('../models/Booking');
const Agreement = require('../models/Agreement');
const Payment = require('../models/Payment');
const Review = require('../models/Review');
const MonthlyBookingCounter = require('../models/MonthlyBookingCounter');
const { requireAuth, requireRole } = require('../middleware/auth');
const { calculateRentalQuote } = require('../utils/pricing');
const { notifyUser } = require('../utils/notify');
const { applyEarningsDelta, hasEarned } = require('../utils/earnings');
const gateway = require('../utils/payments');
const { computeCancellation, refundPlan, roundMoney } = require('../utils/cancellation');
const { BOOKING_STATUS, BOOKING_STATUS_LABELS, CANCELLED_BY, cancelledStatusFor } = require('../utils/statuses');

const router = express.Router();
const TERMS_VERSION = 'revex-v3';
const TERMS = [
  ['Identity verification', 'The renter must provide genuine, valid identity and driving documents before taking the vehicle.'],
  ['Vehicle condition and inspection', 'The owner and renter should record the exterior, fuel level and odometer before pickup and after return. New damage may be charged to the renter.'],
  ['Fuel and charging', 'The vehicle must be returned with the same fuel or charge level. Recharging or fuel recovery charges may apply.'],
  ['Extra kilometres', 'The included kilometre limit and extra-kilometre rate are shown in the booking breakdown. Odometer readings determine the final distance.'],
  ['Responsible use', 'The renter is responsible for tolls, parking, traffic fines, accidents, damage and other charges caused by their use or rule violations.'],
  ['Safe and legal use', 'The vehicle must not be used for illegal activities, racing, reckless driving or by an unauthorized driver. Traffic laws must be followed.'],
  ['Return and late return', 'Return the vehicle at the agreed time and location in the same condition, allowing for normal wear. Late return charges may apply.'],
  ['Cancellation and refund', 'Cancelling within the free-cancellation window is refunded in full. Outside that window the platform cancellation fee shown in the booking breakdown is retained and the balance is refunded to the original payment method. A declined owner request is refunded in the same way. A booking record is never deleted.'],
  ['Agreement acceptance', 'By checking the mandatory agreement box, the renter confirms that they have read, understood and accepted these terms and the applicable vehicle conditions.']
];

function idOf(value) {
  if (!value) return '';
  return String(typeof value === 'object' ? value._id || value.id : value);
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function paymentLabel(status) {
  return ({ pending: 'Pending', paid: 'Paid', failed: 'Failed', refunded: 'Refunded' })[status] || 'Pending';
}

function quoteFromBooking(booking) {
  return {
    price: Number(booking.price ?? booking.pricingSnapshot?.price ?? 0),
    priceUnit: booking.priceUnit || 'hour',
    currency: 'INR',
    durationHours: Number(booking.hours || 0),
    durationLabel: `${booking.hours || 0} hour(s)`,
    billableUnits: Number(booking.billableUnits || 1),
    baseRentalAmount: Number(booking.baseAmount || 0),
    includedKm: Number(booking.includedKm ?? booking.pricingSnapshot?.includedKm ?? 300),
    estimatedKm: Number(booking.estimatedKm || 0),
    extraKm: Number(booking.extraKm || 0),
    extraKmRate: Number(booking.extraKmRate || 0),
    extraKilometerCharges: Number(booking.extraKilometerCharges || 0),
    additionalCharges: Number(booking.additionalCharges || 0),
    discountPercent: Number(booking.discountPercent || 0),
    discountAmount: Number(booking.discountAmount || 0),
    discountedSubtotal: Number(booking.discountedSubtotal ?? (booking.subtotal || 0)),
    taxPercent: Number(booking.taxPercent || 0),
    taxFees: Number(booking.taxFees || 0),
    subtotal: Number(booking.subtotal || 0),
    grandTotal: Number(booking.grandTotal ?? booking.totalAmount ?? 0),
    paidAmount: Number(booking.paidAmount ?? (booking.paymentStatus === 'paid' ? (booking.grandTotal ?? booking.totalAmount ?? 0) : 0)),
    remainingAmount: Number(booking.remainingAmount ?? (booking.paymentStatus === 'paid' ? 0 : (booking.grandTotal ?? booking.totalAmount ?? 0))),
    pricingVersion: booking.pricingSnapshot?.pricingVersion || 'revex-pricing-v3'
  };
}

async function reserveMonthlySlot(userId, key) {
  const updated = await MonthlyBookingCounter.findOneAndUpdate(
    { userId, monthKey: key, count: { $lt: 2 } },
    { $inc: { count: 1 } },
    { returnDocument: 'after' }
  );
  if (updated) return updated.count;
  const [year, month] = key.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const existing = await Booking.countDocuments({ userId, createdAt: { $gte: start, $lt: end }, status: { $in: ['pending', 'payment_pending', 'pending_owner', 'confirmed', 'completed'] } });
  if (existing >= 2) throw Object.assign(new Error('You can make a maximum of 2 active bookings per month.'), { code: 'MONTHLY_LIMIT' });
  try {
    const created = await MonthlyBookingCounter.create({ userId, monthKey: key, count: existing + 1 });
    return created.count;
  } catch (error) {
    if (error.code !== 11000) throw error;
    const retry = await MonthlyBookingCounter.findOneAndUpdate({ userId, monthKey: key, count: { $lt: 2 } }, { $inc: { count: 1 } }, { returnDocument: 'after' });
    if (retry) return retry.count;
    throw Object.assign(new Error('You can make a maximum of 2 active bookings per month.'), { code: 'MONTHLY_LIMIT' });
  }
}

async function releaseMonthlySlot(userId, key) {
  if (!key) return;
  await MonthlyBookingCounter.findOneAndUpdate({ userId, monthKey: key, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

// Clear the slot marker as well as the counter. The legacy unique compound
// index includes documents that still contain monthlySlot, so leaving a
// cancelled record marked as slot 1 would block the next booking.
async function releaseBookingSlot(booking) {
  if (!booking?.monthlySlot || !booking?.monthKey) return;
  await releaseMonthlySlot(booking.userId, booking.monthKey);
  await Booking.updateOne({ _id: booking._id }, { $unset: { monthlySlot: 1 } });
}

async function syncOwnerCounters(ownerId) {
  if (!ownerId) return;
  const [total, approved, pending, rejected, removed] = await Promise.all([
    Vehicle.countDocuments({ ownerId }), Vehicle.countDocuments({ ownerId, status: 'approved' }), Vehicle.countDocuments({ ownerId, status: 'pending' }),
    Vehicle.countDocuments({ ownerId, status: 'rejected' }), Vehicle.countDocuments({ ownerId, status: 'removed' })
  ]);
  const status = approved ? 'approved' : pending ? 'pending' : rejected ? 'rejected' : removed ? 'removed' : 'pending';
  await User.findByIdAndUpdate(ownerId, { $set: { totalCarsOnRent: total, carApprovalStatus: status } });
}

async function createAgreement(bookingId, { legacy = false } = {}) {
  const booking = await Booking.findById(bookingId).populate('userId', 'name email phone').populate({ path: 'vehicleId', populate: { path: 'ownerId', select: 'name email phone' } });
  if (!booking) throw new Error('Booking information is incomplete.');
  const vehicle = booking.vehicleId;
  const owner = vehicle?.ownerId;
  if (!vehicle) throw new Error('Vehicle information is incomplete.');
  const existing = await Agreement.findOne({ bookingId: booking._id });
  const userAccepted = Boolean(booking.agreementAcceptedAt || existing?.acceptedByUser || (legacy && booking.paymentStatus === 'paid'));
  const ownerAccepted = Boolean(existing?.acceptedByOwner);
  const status = booking.status === 'rejected' ? 'rejected' : userAccepted && ownerAccepted ? 'approved' : userAccepted ? 'pending_owner' : 'pending_user';
  const agreementData = {
    bookingId: booking._id,
    agreementId: existing?.agreementId || `AG-${booking._id.toString().slice(-8).toUpperCase()}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
    renterName: booking.userId?.name || 'REVEX Renter', renterEmail: booking.userId?.email || '', renterPhone: booking.userId?.phone || '',
    ownerName: owner?.name || 'Vehicle Owner', ownerEmail: owner?.email || '', ownerPhone: owner?.phone || '',
    vehicleName: vehicle.name || 'REVEX Vehicle', vehicleType: vehicle.type || vehicle.category || '', vehicleCategory: vehicle.category || vehicle.type || '', vehicleFuelType: vehicle.fuelType || 'Petrol',
    vehicleLocation: vehicle.location || '', vehicleNumberPlate: vehicle.numberPlate || '',
    pickupDate: booking.startDate, returnDate: booking.endDate, pickupLocation: vehicle.location || '', returnLocation: vehicle.location || '',
    hours: booking.hours || 0, estimatedKm: booking.estimatedKm || 0,
    rentalAmount: booking.grandTotal ?? booking.totalAmount ?? 0,
    baseAmount: booking.baseAmount || 0, additionalCharges: booking.additionalCharges || 0, discountPercent: booking.discountPercent || 0, discountAmount: booking.discountAmount || 0, extraKilometerCharges: booking.extraKilometerCharges || 0,
    taxFees: booking.taxFees || 0, grandTotal: booking.grandTotal ?? booking.totalAmount ?? 0, pricingSnapshot: booking.pricingSnapshot || quoteFromBooking(booking),
    paymentStatus: paymentLabel(booking.paymentStatus).toUpperCase(),
    agreementStatus: status, acceptedByUser: userAccepted, acceptedAt: userAccepted ? (existing?.acceptedAt || booking.agreementAcceptedAt || new Date()) : null,
    acceptedByOwner: ownerAccepted, ownerAcceptedAt: existing?.ownerAcceptedAt || null,
    termsVersion: TERMS_VERSION, termsSnapshot: TERMS.map(item => `${item[0]}: ${item[1]}`),
    ownerDecisionReason: existing?.ownerDecisionReason || ''
  };
  if (existing) {
    existing.set(agreementData);
    await existing.save();
    return existing;
  }
  return Agreement.create(agreementData);
}

// PDF text operators are byte-oriented. The standard Helvetica/WinAnsi fonts
// cannot render arbitrary Unicode, so text is transliterated to WinAnsi-safe
// ASCII first. Without this, a name such as "Ananya" or a rupee sign produced
// an unreadable PDF and desynchronised the cross-reference table.
function escapePdfText(value) {
  const text = String(value ?? '')
    .replace(/[\u20B9]/g, 'Rs.')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  // Drop anything still outside printable WinAnsi rather than emitting a byte
  // sequence the font cannot map.
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function makeAgreementPdf(agreement) {
  const date = value => { try { return new Date(value).toLocaleString('en-IN'); } catch { return String(value || '-'); } };
  const quote = agreement.pricingSnapshot || {};
  const lines = [
    'REVEX RENTAL AGREEMENT', 'Move Smart. Share More.', '',
    `Agreement ID: ${agreement.agreementId}`, `Booking ID: ${agreement.bookingId}`, `Generated: ${date(new Date())}`, '',
    'BOOKING DETAILS', `Rental start: ${date(agreement.pickupDate)}`, `Return: ${date(agreement.returnDate)}`, `Rental duration: ${agreement.hours || 0} hour(s)`, `Pickup: ${agreement.pickupLocation || '-'}`,
    '', 'VEHICLE', `Vehicle: ${agreement.vehicleName}`, `Category: ${agreement.vehicleCategory || agreement.vehicleType || '-'}`, `Fuel: ${agreement.vehicleFuelType || '-'}`, `Registration: ${agreement.vehicleNumberPlate || 'As listed'}`, '',
    'RENTER', `${agreement.renterName} | ${agreement.renterEmail} | ${agreement.renterPhone || ''}`, '', 'OWNER', `${agreement.ownerName} | ${agreement.ownerEmail} | ${agreement.ownerPhone || ''}`, '',
    'PAYMENT BREAKDOWN', `Base rental amount: Rs. ${agreement.baseAmount || agreement.rentalAmount || 0}`, `Additional charges: Rs. ${agreement.additionalCharges || 0}`, `Discount: Rs. ${agreement.discountAmount || 0}`, `Extra kilometre charges: Rs. ${agreement.extraKilometerCharges || 0}`, `Tax / fees: Rs. ${agreement.taxFees || 0}`, `Grand total: Rs. ${agreement.grandTotal || agreement.rentalAmount || 0}`, `Payment status: ${agreement.paymentStatus}`, '',
    ...TERMS.flatMap(item => [item[0].toUpperCase(), item[1], '']),
    `Renter acceptance: ${agreement.acceptedByUser ? 'YES' : 'PENDING'}`, `Owner acceptance: ${agreement.acceptedByOwner ? 'YES' : 'PENDING'}`, '', 'Generated by REVEX from the booking record.'
  ];
  const wrapped = [];
  for (const line of lines) {
    if (!line) { wrapped.push(''); continue; }
    for (let index = 0; index < line.length; index += 90) wrapped.push(line.slice(index, index + 90));
  }
  const content = ['BT', '/F1 16 Tf', '48 760 Td'];
  wrapped.forEach((line, index) => { if (index) content.push('0 -20 Td'); content.push(`(${escapePdfText(line)}) Tj`); });
  content.push('ET');
  // The stream length and the xref offsets must all be measured in the SAME
  // encoding the buffer is written with (latin1), otherwise strict readers
  // reject the file whenever the content is multi-byte.
  const streamBody = content.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(streamBody, 'latin1')} >>\nstream\n${streamBody}\nendstream`
  ];
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  const byteLength = value => Buffer.byteLength(value, 'latin1');
  objects.forEach((object, index) => { offsets[index + 1] = byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * The Razorpay client and the cancellation policy now live in
 * utils/payments.js and utils/cancellation.js and are shared with the ride
 * flow. This file previously had its own copy of the gateway code, which is how
 * the two flows drifted apart.
 */
function razorpayConfigured() { return gateway.isConfigured(); }

/** Marks a payment ledger row as refunded so admin reports stay accurate. */
async function markPaymentRefunded(reference, amount) {
  if (!reference) return;
  try {
    await Payment.findOneAndUpdate(
      { reference, status: 'paid' },
      { $set: { status: amount > 0 ? 'refunded' : 'paid', refundAmount: amount, refundedAt: amount > 0 ? new Date() : null } }
    );
  } catch (error) {
    console.warn('[bookings] payment refund sync failed:', error.message);
  }
}

async function recordPayment(booking, method, reference, providerData = {}) {
  try {
    await Payment.create({ bookingId: booking._id, userId: booking.userId, vehicleId: booking.vehicleId, kind: 'rental', amount: booking.grandTotal || booking.totalAmount, currency: 'INR', method, status: 'paid', reference, providerData, paidAt: new Date() });
  } catch (error) {
    if (error.code !== 11000) console.warn('Payment record sync failed:', error.message);
  }
}

router.post('/', requireAuth, async (req, res) => {
  const { vehicleId, startDate, endDate, estimatedKm = 0, panNumber = '', drivingLicenseNumber = '' } = req.body;
  if (req.body.agreementAccepted !== true && req.body.agreementAccepted !== 'true') return res.status(400).json({ message: 'Read and accept the Rental Agreement and Terms & Conditions before continuing.' });
  if (!mongoose.isValidObjectId(vehicleId)) return res.status(400).json({ message: 'Valid vehicleId is required.' });
  const pan = String(panNumber).trim().toUpperCase();
  const drivingLicense = String(drivingLicenseNumber).trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return res.status(400).json({ message: 'Enter a valid PAN number (example: ABCDE1234F).' });
  if (drivingLicense.length < 6 || drivingLicense.length > 25) return res.status(400).json({ message: 'Enter a valid driving licence number.' });
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return res.status(400).json({ message: 'Valid start and end dates are required.' });
  if (start <= new Date()) return res.status(400).json({ message: 'Booking start time must be in the future.' });
  const km = Number(estimatedKm) || 0;
  if (km < 0 || km > 100000) return res.status(400).json({ message: 'Estimated distance must be between 0 and 100,000 km.' });
  const vehicle = await Vehicle.findById(vehicleId);
  if (!vehicle || !vehicle.verified || !['approved', 'available'].includes(vehicle.status) || vehicle.availability === 'unavailable') return res.status(404).json({ message: 'Vehicle is not available for booking.' });
  if (vehicle.availableFrom && new Date(vehicle.availableFrom) > start) return res.status(404).json({ message: 'This vehicle is not available at the selected start time.' });
  if (String(vehicle.ownerId) === String(req.user._id)) return res.status(403).json({ message: 'You cannot book your own vehicle.' });
  const overlap = await Booking.findOne({ vehicleId, status: { $in: ['pending', 'payment_pending', 'pending_owner', 'confirmed', 'approved'] }, startDate: { $lt: end }, endDate: { $gt: start } });
  if (overlap) return res.status(409).json({ message: 'Vehicle is already booked for part of this time.' });
  let quote;
  try { quote = calculateRentalQuote({ vehicle, startDate: start, endDate: end, estimatedKm: km }); } catch (error) { return res.status(error.statusCode || 400).json({ message: error.message }); }
  const key = monthKey(new Date());
  let slot;
  try { slot = await reserveMonthlySlot(req.user._id, key); } catch (error) { return res.status(error.code === 'MONTHLY_LIMIT' ? 429 : 500).json({ message: error.message || 'Booking limit service is unavailable.' }); }
  let booking;
  try {
    // Re-check after reserving the monthly slot to narrow the overlap race
    // window when two renters submit at the same time.
    const freshOverlap = await Booking.findOne({ vehicleId: vehicle._id, status: { $in: ['pending', 'payment_pending', 'pending_owner', 'confirmed', 'approved'] }, startDate: { $lt: end }, endDate: { $gt: start } });
    if (freshOverlap) { await releaseMonthlySlot(req.user._id, key); return res.status(409).json({ message: 'Vehicle is already booked for part of this time.' }); }
    booking = await Booking.create({
      userId: req.user._id, vehicleId: vehicle._id, ownerId: vehicle.ownerId, startDate: start, endDate: end, estimatedKm: km,
      panNumber: pan, drivingLicenseNumber: drivingLicense, paymentMethod: 'demo', hours: quote.durationHours,
      price: quote.price, priceUnit: quote.priceUnit, billableUnits: quote.billableUnits, includedKm: quote.includedKm, baseAmount: quote.baseRentalAmount, extraKm: quote.extraKm, extraKmRate: quote.extraKmRate,
      extraKilometerCharges: quote.extraKilometerCharges, additionalCharges: quote.additionalCharges, discountPercent: quote.discountPercent, discountAmount: quote.discountAmount, discountedSubtotal: quote.discountedSubtotal, taxPercent: quote.taxPercent, taxFees: quote.taxFees,
      subtotal: quote.subtotal, grandTotal: quote.grandTotal, totalAmount: quote.grandTotal, paidAmount: 0, remainingAmount: quote.grandTotal,
      pricingSnapshot: quote, monthKey: key, monthlySlot: slot, status: 'payment_pending', paymentStatus: 'pending', agreementAcceptedAt: new Date()
    });
  } catch (error) {
    await releaseMonthlySlot(req.user._id, key);
    return res.status(400).json({ message: error.code === 11000 ? 'A booking is already being created for this account.' : error.message || 'Booking could not be created.' });
  }
  try {
    const agreement = await createAgreement(booking._id);
    await notifyUser(vehicle.ownerId, { type: 'booking', title: 'New booking request', message: `${req.user.name} requested ${vehicle.name}.`, data: { bookingId: booking._id.toString(), vehicleId: vehicle._id.toString() } });
    const populated = await Booking.findById(booking._id).populate('vehicleId', 'name category type location price priceUnit image vehiclePicture fuelType currentKm').lean();
    res.status(201).json({ ...populated, id: booking._id.toString(), quote, pricing: quote, agreement: agreement.toObject(), payment: { method: 'demo', amount: Math.round(quote.grandTotal * 100), currency: 'INR', displayAmount: quote.grandTotal } });
  } catch (error) {
    await Booking.findByIdAndDelete(booking._id);
    await releaseMonthlySlot(req.user._id, key);
    res.status(500).json({ message: 'The agreement could not be prepared. No booking was created.' });
  }
});

router.post('/:id/payment-order', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  if (!razorpayConfigured()) return res.status(503).json({ message: 'Online payment is not configured on this server. Use the labelled test payment instead.' });
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user._id, status: 'payment_pending', paymentStatus: 'pending' });
    if (!booking) return res.status(404).json({ message: 'This booking is no longer awaiting payment.' });
    // The amount comes from the stored booking, never from the browser.
    const order = await gateway.createOrder({
      amount: roundMoney(booking.grandTotal || booking.totalAmount),
      receipt: `REVEX-${booking._id}`,
      notes: { bookingId: String(booking._id), vehicleId: idOf(booking.vehicleId) }
    });
    booking.paymentMethod = 'razorpay';
    booking.razorpayOrderId = order.id;
    await booking.save();
    res.json({ order_id: order.id, order, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    console.error('[bookings] payment-order failed:', error.code || '', error.message);
    // Never 401. A Razorpay 401 means the SERVER's keys are wrong, and the
    // browser treats our 401 as an expired session and logs the renter out.
    const rejected = error.code === 'GATEWAY_CREDENTIALS_REJECTED';
    res.status(rejected ? 502 : (Number(error.statusCode) === 400 ? 400 : 502)).json({
      message: error.message || 'The payment gateway could not create an order.',
      code: error.code || 'GATEWAY_ERROR'
    });
  }
});

/**
 * Test payment for installations with no Razorpay keys.
 *
 * It is a real server-side state change (never a client-side success message),
 * it is stored with paymentMethod "demo" so it can never be mistaken for real
 * money, and it is refused outright once a real gateway is configured.
 */
async function recordTestPayment(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  // The same probe the client is shown, so the two can never disagree about
  // whether a demo payment is allowed.
  const health = await gateway.checkHealth();
  if (health.usable) return res.status(409).json({ message: 'Online payment is working on this server, so the test payment is disabled. Use the Razorpay checkout.' });
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user._id, status: 'payment_pending', paymentStatus: 'pending' });
    if (!booking) return res.status(404).json({ message: 'This booking is no longer awaiting payment.' });
    const agreement = await Agreement.findOne({ bookingId: booking._id });
    if (!agreement?.acceptedByUser) return res.status(403).json({ message: 'Accept the Rental Agreement and Terms & Conditions before payment.' });
    const reference = `REVEX-TEST-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, userId: req.user._id, status: 'payment_pending', paymentStatus: 'pending' },
      { $set: { paymentStatus: 'paid', paidAmount: booking.grandTotal, remainingAmount: 0, status: 'pending_owner', paymentMethod: 'demo', paymentReference: reference } },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'This booking was already processed. Please refresh your bookings.' });
    await recordPayment(updated, 'demo', reference, { testMode: true });
    const savedAgreement = await createAgreement(updated._id);
    await notifyUser(updated.ownerId, { type: 'payment', title: 'Booking payment received', message: `Test payment recorded for booking ${updated._id}. Please review the request.`, data: { bookingId: updated._id.toString() } });
    res.json({
      success: true,
      message: 'Test payment recorded. Your request is now waiting for owner approval.',
      booking: { ...updated.toObject(), id: updated._id.toString(), quote: quoteFromBooking(updated) },
      agreement: savedAgreement.toObject(),
      paymentReference: reference,
      testMode: true
    });
  } catch (error) {
    console.error('[bookings] test payment failed:', error.message);
    res.status(500).json({ message: 'The test payment could not be recorded.' });
  }
}

router.post('/:id/payment-demo', requireAuth, recordTestPayment);
router.post('/:id/payment-test', requireAuth, recordTestPayment);

router.post('/:id/verify-payment', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  if (!razorpayConfigured()) return res.status(503).json({ message: 'Razorpay is not configured on this server.' });
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user._id });
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    // Idempotent: Razorpay retries the callback, and a duplicate must not fail.
    if (booking.paymentStatus === 'paid') {
      return res.json({ success: true, message: 'Payment already verified.', booking: { ...booking.toObject(), id: booking._id.toString(), quote: quoteFromBooking(booking) }, agreement: await createAgreement(booking._id) });
    }
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (!orderId || !paymentId || !signature) return res.status(400).json({ message: 'Payment verification data is incomplete.' });
    if (orderId !== booking.razorpayOrderId) return res.status(400).json({ message: 'Payment order does not match this booking.' });

    const result = await gateway.verifyCheckout({
      orderId, paymentId, signature,
      expectedAmountPaise: gateway.toPaise(roundMoney(booking.grandTotal || booking.totalAmount))
    });
    if (!result.ok) {
      // A forged or mismatched callback is recorded as a failure, never ignored.
      await Booking.findOneAndUpdate(
        { _id: booking._id, userId: req.user._id, paymentStatus: { $ne: 'paid' } },
        { $set: { paymentStatus: 'failed', status: 'cancelled_by_user', cancellation: { cancelledBy: CANCELLED_BY.USER, cancelledById: req.user._id, reason: result.reason, cancelledAt: new Date(), originalAmount: 0, cancellationFee: 0, refundAmount: 0, finalAmount: 0 } } },
        { returnDocument: 'before' }
      );
      await releaseBookingSlot(booking);
      return res.status(400).json({ message: `${result.reason} The booking was not confirmed.` });
    }

    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, userId: req.user._id, status: 'payment_pending', paymentStatus: 'pending' },
      { $set: { paymentStatus: 'paid', paidAmount: booking.grandTotal, remainingAmount: 0, status: 'pending_owner', paymentMethod: 'razorpay', paymentReference: paymentId, razorpayPaymentId: paymentId, razorpaySignature: signature } },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'This booking was already processed. Please refresh your bookings.' });
    await recordPayment(updated, 'razorpay', paymentId, { orderId, signature, amount: result.payment?.amount });
    const agreement = await createAgreement(updated._id);
    await notifyUser(updated.ownerId, { type: 'payment', title: 'Booking payment received', message: `Payment received for booking ${updated._id}. Please review the request.`, data: { bookingId: updated._id.toString() } });
    res.json({ success: true, message: 'Payment verified. Your request is waiting for owner approval.', booking: { ...updated.toObject(), id: booking._id.toString(), quote: quoteFromBooking(booking) }, agreement: agreement.toObject() });
  } catch (error) {
    console.error('[bookings] verify-payment failed:', error.message);
    res.status(500).json({ message: 'Payment verification failed. Please try again.' });
  }
});

router.post('/:id/payment-failed', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  const booking = await Booking.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id, status: 'payment_pending', paymentStatus: { $ne: 'paid' } },
    { $set: { paymentStatus: 'failed', status: 'cancelled_by_user', cancellation: { cancelledBy: CANCELLED_BY.USER, cancelledById: req.user._id, reason: 'Payment was not completed.', cancelledAt: new Date(), originalAmount: 0, cancellationFee: 0, refundAmount: 0, finalAmount: 0 } } },
    { returnDocument: 'before' }
  );
  if (!booking) return res.status(404).json({ message: 'This booking cannot be marked as failed.' });
  await releaseBookingSlot(booking);
  res.json({ success: true, message: 'Payment was not completed, so the booking was released.' });
});

/**
 * Cancellation for a rental booking.
 *
 * The renter, the vehicle owner and an admin may all cancel. The fee and the
 * refund come from the single configurable policy, the refund is issued through
 * Razorpay when money was really collected, and the record is never deleted.
 */
router.post('/:id/cancel', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  try {
    const booking = await Booking.findById(req.params.id).populate('vehicleId', 'ownerId name');
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    const renterId = idOf(booking.userId);
    const ownerId = idOf(booking.ownerId || booking.vehicleId?.ownerId);
    const isRenter = renterId === idOf(req.user._id);
    const isOwner = ownerId === idOf(req.user._id);
    const isAdmin = req.user.role === 'admin';
    if (!isRenter && !isOwner && !isAdmin) return res.status(403).json({ message: 'You cannot cancel this booking.' });

    const cancellable = ['pending', 'payment_pending', 'pending_owner', 'confirmed'];
    if (!cancellable.includes(booking.status)) return res.status(409).json({ message: 'This booking cannot be cancelled in its current state.' });

    const actor = isAdmin ? CANCELLED_BY.ADMIN : (isOwner && !isRenter ? CANCELLED_BY.OWNER : CANCELLED_BY.USER);
    const reason = String(req.body?.reason || '').trim().slice(0, 500)
      || (actor === CANCELLED_BY.USER ? 'Cancelled by the renter.' : actor === CANCELLED_BY.OWNER ? 'Cancelled by the vehicle owner.' : 'Cancelled by an administrator.');

    // A confirmed booking already credited the owner, so cancel reverses it.
    const earnedBeforeCancel = hasEarned(booking.status) && booking.paymentStatus === 'paid';
    const paid = booking.paymentStatus === 'paid';
    const paidAmount = roundMoney(booking.grandTotal || booking.totalAmount);

    const policy = computeCancellation({
      amount: paid ? paidAmount : 0,
      actor,
      startsAt: booking.startDate,
      reason,
      flow: 'rental',
      platformFee: booking.pricingSnapshot?.platformFee ?? booking.discountedSubtotal * 0.1
    });
    const plan = refundPlan({ amount: paid ? paidAmount : 0, fee: policy.cancellationFee, method: booking.paymentMethod });

    let outcome = { ok: true, refund: null, reason: '' };
    if (plan.refundable && paid && booking.paymentMethod === 'razorpay') {
      const result = await gateway.refund({
        paymentId: booking.razorpayPaymentId || booking.paymentReference,
        amount: plan.refundAmount,
        receipt: `REVEX-BOOK-CXL-${booking._id}`.slice(0, 40),
        notes: { reason: `Cancelled by ${actor}` }
      });
      outcome = result.ok
        ? { ok: true, refund: result.refund, reason: '' }
        : { ok: false, refund: null, reason: result.reason };
    }

    booking.status = cancelledStatusFor(actor, 'rental');
    booking.cancellation = {
      cancelledBy: actor,
      cancelledById: req.user._id,
      reason,
      cancelledAt: new Date(),
      originalAmount: policy.originalAmount,
      cancellationFee: policy.cancellationFee,
      cancellationFeePercent: policy.cancellationFeePercent,
      refundAmount: plan.refundAmount,
      finalAmount: plan.refundAmount,
      platformFee: policy.platformFee,
      withinFreeWindow: policy.withinFreeWindow,
      policyVersion: policy.policyVersion,
      explanation: policy.explanation
    };
    if (paid) {
      booking.paymentStatus = plan.refundable ? 'refunded' : 'paid';
      booking.refund = {
        id: outcome.refund?.id || '',
        amount: plan.refundAmount,
        status: outcome.ok ? (outcome.refund?.status || (booking.paymentMethod === 'razorpay' ? 'requested' : 'manual')) : 'failed',
        processedAt: new Date(),
        note: outcome.ok ? plan.note : (outcome.reason || 'The refund could not be processed automatically.')
      };
      if (plan.refundable) await markPaymentRefunded(booking.razorpayPaymentId || booking.paymentReference, plan.refundAmount);
    }
    await booking.save();
    await releaseBookingSlot(booking);

    if (earnedBeforeCancel) {
      await applyEarningsDelta(booking, -1);
      await notifyUser(ownerId, { type: 'booking', title: 'Booking cancelled', message: 'A confirmed booking for your vehicle was cancelled, so its earnings were reversed.', data: { bookingId: booking._id.toString() } });
    } else if (actor !== CANCELLED_BY.OWNER) {
      await notifyUser(ownerId, { type: 'booking', title: 'Booking cancelled', message: `Booking ${booking._id} was cancelled by the renter.`, data: { bookingId: booking._id.toString() } });
    }
    if (actor !== CANCELLED_BY.USER) {
      await notifyUser(renterId, {
        type: 'booking',
        title: 'Booking cancelled',
        message: `Your booking for ${booking.vehicleId?.name || 'the vehicle'} was cancelled${actor === CANCELLED_BY.ADMIN ? ' by an administrator' : ' by the owner'}.${plan.refundable ? ` ₹${plan.refundAmount} is refunded.` : ''}`,
        data: { bookingId: booking._id.toString() }
      });
    }

    res.json({
      success: true,
      message: outcome.ok
        ? `Booking cancelled. ${plan.refundable ? `₹${plan.refundAmount} is refunded to the renter.` : 'No refund was due.'}`
        : 'Booking cancelled, but the automatic refund failed and must be processed manually.',
      booking: { ...booking.toObject(), id: booking._id.toString(), statusLabel: BOOKING_STATUS_LABELS[booking.status] || booking.status },
      cancellation: booking.cancellation,
      refund: { ...plan, gateway: outcome.refund, gatewayError: outcome.ok ? null : outcome.reason }
    });
  } catch (error) {
    console.error('[bookings] cancel failed:', error.message);
    res.status(500).json({ message: 'The booking could not be cancelled.' });
  }
});

/**
 * Cancellation preview. The UI calls this BEFORE showing a confirm dialog so the
 * fee and refund the customer sees are the same numbers the cancel route will
 * apply, not an estimate written in the frontend.
 */
router.get('/:id/cancellation-preview', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  try {
    const booking = await Booking.findById(req.params.id).populate('vehicleId', 'ownerId name');
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    const renterId = idOf(booking.userId);
    const ownerId = idOf(booking.ownerId || booking.vehicleId?.ownerId);
    const isRenter = renterId === idOf(req.user._id);
    const isOwner = ownerId === idOf(req.user._id);
    if (!isRenter && !isOwner && req.user.role !== 'admin') return res.status(403).json({ message: 'You cannot view this booking.' });
    const actor = req.user.role === 'admin' ? CANCELLED_BY.ADMIN : (isOwner && !isRenter ? CANCELLED_BY.OWNER : CANCELLED_BY.USER);
    const paid = booking.paymentStatus === 'paid';
    const paidAmount = roundMoney(booking.grandTotal || booking.totalAmount);
    const policy = computeCancellation({
      amount: paid ? paidAmount : 0, actor, startsAt: booking.startDate, flow: 'rental',
      platformFee: booking.pricingSnapshot?.platformFee ?? booking.discountedSubtotal * 0.1
    });
    const plan = refundPlan({ amount: paid ? paidAmount : 0, fee: policy.cancellationFee, method: booking.paymentMethod });
    res.json({
      cancellable: ['pending', 'payment_pending', 'pending_owner', 'confirmed'].includes(booking.status),
      status: booking.status,
      statusLabel: BOOKING_STATUS_LABELS[booking.status] || booking.status,
      vehicleName: booking.vehicleId?.name || 'Vehicle',
      startDate: booking.startDate,
      endDate: booking.endDate,
      ...policy,
      refund: plan
    });
  } catch (error) {
    console.error('[bookings] cancellation preview failed:', error.message);
    res.status(500).json({ message: 'The cancellation details could not be calculated.' });
  }
});

router.post('/:id/feedback', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  const booking = await Booking.findById(req.params.id).populate('userId', '_id name').populate('vehicleId', '_id name ownerId rating');
  if (!booking) return res.status(404).json({ message: 'Booking not found.' });
  if (idOf(booking.userId?._id || booking.userId) !== idOf(req.user._id)) return res.status(403).json({ message: 'Only the renter can rate this vehicle.' });
  if (!['confirmed', 'completed'].includes(booking.status) || booking.paymentStatus !== 'paid') return res.status(400).json({ message: 'You can rate a confirmed or completed paid rental.' });
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: 'Rating must be a whole number from 1 to 5.' });
  booking.rating = rating; booking.comment = String(req.body.comment || '').trim().slice(0, 500); await booking.save();
  await Review.findOneAndUpdate({ bookingId: booking._id }, { $set: { userId: booking.userId._id || booking.userId, vehicleId: booking.vehicleId._id || booking.vehicleId, rating, comment: booking.comment } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
  const aggregate = await Review.aggregate([{ $match: { vehicleId: booking.vehicleId._id || booking.vehicleId } }, { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }]);
  await Vehicle.findByIdAndUpdate(booking.vehicleId._id || booking.vehicleId, { rating: Math.round((aggregate[0]?.average || 5) * 10) / 10, reviewCount: aggregate[0]?.count || 0 });
  res.json({ success: true, message: 'Feedback submitted successfully.', booking: { ...booking.toObject(), id: booking._id.toString() } });
});

router.get('/owner/summary', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const vehicleQuery = req.user.role === 'admin' ? {} : { ownerId: req.user._id };
    const vehicles = await Vehicle.find(vehicleQuery).select('_id ownerId name type category location price numberPlate image status verified availability rating totalEarnings totalRentals').lean();
    const vehicleIds = vehicles.map(vehicle => vehicle._id);
    const countQuery = req.user.role === 'admin' ? {} : { ownerId: req.user._id };
    const [approved, pending, rejected, removed] = await Promise.all([
      Vehicle.countDocuments({ ...countQuery, status: 'approved' }), Vehicle.countDocuments({ ...countQuery, status: 'pending' }), Vehicle.countDocuments({ ...countQuery, status: 'rejected' }), Vehicle.countDocuments({ ...countQuery, status: 'removed' })
    ]);
    if (!vehicleIds.length) return res.json({ totalEarnings: 0, completedEarnings: 0, paidBookings: 0, pendingPayments: 0, pendingPaymentCount: 0, activeBookings: 0, completedRentals: 0, cancelledBookings: 0, totalBookings: 0, totalVehicles: 0, approvedVehicles: 0, pendingVehicles: 0, rejectedVehicles: 0, removedVehicles: 0, rentedVehicles: 0, revenuePerVehicle: [], vehicles: [], recent: [], bookingRequests: [], carApprovalStatus: 'pending' });
    const match = { vehicleId: { $in: vehicleIds } };
    const [paidAgg, completedAgg, pendingAgg, activeCount, completedCount, cancelledCount, totalCount, paidCount, rentedVehicleIds, recent, requests] = await Promise.all([
      Booking.aggregate([{ $match: { ...match, paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } } }, { $group: { _id: null, total: { $sum: { $multiply: ['$grandTotal', 0.9] } } } }]),
      Booking.aggregate([{ $match: { ...match, paymentStatus: 'paid', status: 'completed' } }, { $group: { _id: null, total: { $sum: { $multiply: ['$grandTotal', 0.9] } } } }]),
      Booking.aggregate([{ $match: { ...match, paymentStatus: 'pending', status: 'payment_pending' } }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]),
      Booking.countDocuments({ ...match, status: { $in: ['confirmed', 'pending_owner'] } }), Booking.countDocuments({ ...match, status: 'completed' }), Booking.countDocuments({ ...match, status: 'cancelled' }), Booking.countDocuments(match), Booking.countDocuments({ ...match, paymentStatus: 'paid', status: { $in: ['confirmed', 'completed'] } }), Booking.distinct('vehicleId', { ...match, status: { $in: ['confirmed', 'completed'] }, paymentStatus: 'paid' }),
      Booking.find(match).populate('userId', 'name email').populate('vehicleId', 'name type category numberPlate fuelType image').sort({ createdAt: -1 }).limit(10).lean(),
      Booking.find({ ...match, status: { $in: ['payment_pending', 'pending_owner'] } }).populate('userId', 'name email phone').populate('vehicleId', 'name type category numberPlate fuelType image').sort({ createdAt: -1 }).lean()
    ]);
    const perVehicle = await Booking.aggregate([{ $match: { ...match, status: { $in: ['confirmed', 'completed'] }, paymentStatus: 'paid' } }, { $group: { _id: '$vehicleId', totalBookings: { $sum: 1 }, completedRentals: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }, earnings: { $sum: { $multiply: ['$grandTotal', 0.9] } } } }, { $sort: { earnings: -1 } }]);
    const perMap = Object.fromEntries(perVehicle.map(item => [idOf(item._id), item]));
    const names = Object.fromEntries(vehicles.map(vehicle => [idOf(vehicle._id), vehicle.name]));
    const serializeRecent = item => ({ ...item, id: idOf(item._id), userId: item.userId ? { ...item.userId, id: idOf(item.userId) } : null, vehicleId: item.vehicleId ? { ...item.vehicleId, id: idOf(item.vehicleId) } : null });
    res.json({
      totalEarnings: Math.round(paidAgg[0]?.total || 0), completedEarnings: Math.round(completedAgg[0]?.total || 0), paidBookings: paidCount,
      pendingPayments: Math.round(pendingAgg[0]?.total || 0), pendingPaymentCount: pendingAgg[0]?.count || 0, activeBookings: activeCount, completedRentals: completedCount, cancelledBookings: cancelledCount, totalBookings: totalCount,
      totalVehicles: vehicles.length, approvedVehicles: approved, pendingVehicles: pending, rejectedVehicles: rejected, removedVehicles: removed, rentedVehicles: rentedVehicleIds.length,
      vehicles: vehicles.map(vehicle => { const item = perMap[idOf(vehicle._id)] || {}; return { ...vehicle, id: idOf(vehicle._id), ownerId: idOf(vehicle.ownerId), category: vehicle.category || vehicle.type, approvalLabel: ({ approved: 'Approved', pending: 'Pending Approval', rejected: 'Rejected', removed: 'Removed / Deregistered' })[vehicle.status] || 'Pending Approval', totalBookings: item.totalBookings || 0, completedRentals: item.completedRentals || 0, earnings: Math.round(item.earnings || 0) }; }),
      revenuePerVehicle: perVehicle.map(item => ({ ...item, vehicleId: idOf(item._id), vehicleName: names[idOf(item._id)] || 'Vehicle', earnings: Math.round(item.earnings || 0) })),
      recent: recent.map(serializeRecent), bookingRequests: requests.map(serializeRecent), carApprovalStatus: approved ? 'approved' : pending ? 'pending' : rejected ? 'rejected' : 'removed'
    });
  } catch (error) { res.status(500).json({ message: 'Owner dashboard could not be loaded.' }); }
});

router.get('/owner/requests', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const vehicleQuery = req.user.role === 'admin' ? {} : { ownerId: req.user._id };
    const vehicles = await Vehicle.find(vehicleQuery).select('_id').lean();
    const ids = vehicles.map(vehicle => vehicle._id);
    const query = { vehicleId: { $in: ids } };
    // `status=all` means "no status filter", not a status literally called
    // "all" - which would match nothing and silently show an empty screen.
    const requestedStatus = String(req.query.status || '').toLowerCase();
    if (requestedStatus && requestedStatus !== 'all') query.status = requestedStatus;
    else query.status = { $in: ['payment_pending', 'pending_owner', 'confirmed', 'completed', 'rejected'] };
    const bookings = await Booking.find(query).populate('userId', 'name email phone').populate('vehicleId', 'name type category numberPlate fuelType image').sort({ createdAt: -1 }).lean();
    const agreementIds = bookings.map(booking => booking._id);
    const agreements = await Agreement.find({ bookingId: { $in: agreementIds } }).lean();
    const agreementMap = Object.fromEntries(agreements.map(item => [idOf(item.bookingId), item]));
    res.json(bookings.map(booking => ({ ...booking, id: idOf(booking._id), quote: quoteFromBooking(booking), agreement: agreementMap[idOf(booking._id)] ? { ...agreementMap[idOf(booking._id)], id: idOf(agreementMap[idOf(booking._id)]._id) } : null })));
  } catch (error) { res.status(500).json({ message: 'Booking requests could not be loaded.' }); }
});

router.post('/:id/owner-decision', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking request not found.' });
  try {
    const decision = String(req.body.decision || '').toLowerCase();
    const reason = String(req.body.reason || '').trim().slice(0, 1000);
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ message: 'Choose approve or reject.' });
    if (decision === 'reject' && !reason) return res.status(400).json({ message: 'Enter a reason for rejecting this request.' });
    const booking = await Booking.findById(req.params.id).populate('vehicleId', 'ownerId name');
    if (!booking) return res.status(404).json({ message: 'Booking request not found.' });
    const ownerId = idOf(booking.ownerId || booking.vehicleId?.ownerId);
    if (req.user.role !== 'admin' && ownerId !== idOf(req.user._id)) return res.status(403).json({ message: 'Only the vehicle owner can decide this request.' });
    if (booking.status !== 'pending_owner') return res.status(409).json({ message: 'This booking request has already been processed.' });

    if (decision === 'approve') {
      const updated = await Booking.findOneAndUpdate(
        { _id: booking._id, status: 'pending_owner' },
        { $set: { status: 'confirmed', ownerDecision: { decision: 'approved', reason, decidedAt: new Date(), decidedBy: req.user._id } } },
        { returnDocument: 'after' }
      );
      if (!updated) return res.status(409).json({ message: 'This booking request has already been processed.' });
      const agreement = await Agreement.findOne({ bookingId: booking._id });
      if (agreement) {
        agreement.acceptedByOwner = true;
        agreement.ownerAcceptedAt = new Date();
        agreement.agreementStatus = 'approved';
        agreement.ownerDecisionReason = reason;
        await agreement.save();
      }
      await applyEarningsDelta(updated, 1);
      await notifyUser(updated.userId, { type: 'booking', title: 'Booking approved', message: 'The owner approved your rental request.', data: { bookingId: updated._id.toString() } });
      return res.json({ success: true, message: 'Booking request approved.', booking: { ...updated.toObject(), id: updated._id.toString() } });
    }

    // Rejecting a PAID request must refund what the renter paid, less the
    // policy fee for an owner-caused cancellation.
    const paid = booking.paymentStatus === 'paid';
    const paidAmount = roundMoney(booking.grandTotal || booking.totalAmount);
    const policy = computeCancellation({
      amount: paid ? paidAmount : 0,
      actor: CANCELLED_BY.OWNER,
      startsAt: booking.startDate,
      reason,
      flow: 'rental',
      platformFee: booking.pricingSnapshot?.platformFee ?? booking.discountedSubtotal * 0.1
    });
    const plan = refundPlan({ amount: paid ? paidAmount : 0, fee: policy.cancellationFee, method: booking.paymentMethod });

    let outcome = { ok: true, refund: null, reason: '' };
    if (plan.refundable && paid && booking.paymentMethod === 'razorpay') {
      const result = await gateway.refund({
        paymentId: booking.razorpayPaymentId || booking.paymentReference,
        amount: plan.refundAmount,
        receipt: `REVEX-BOOK-REJ-${booking._id}`.slice(0, 40),
        notes: { reason: 'Owner rejected the request' }
      });
      outcome = result.ok
        ? { ok: true, refund: result.refund, reason: '' }
        : { ok: false, refund: null, reason: result.reason };
    }

    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, status: 'pending_owner' },
      {
        $set: {
          status: 'rejected',
          ownerDecision: { decision: 'rejected', reason, decidedAt: new Date(), decidedBy: req.user._id },
          cancellation: {
            cancelledBy: CANCELLED_BY.OWNER, cancelledById: req.user._id, reason, cancelledAt: new Date(),
            originalAmount: policy.originalAmount, cancellationFee: policy.cancellationFee,
            cancellationFeePercent: policy.cancellationFeePercent, refundAmount: plan.refundAmount,
            finalAmount: plan.refundAmount, platformFee: policy.platformFee,
            withinFreeWindow: policy.withinFreeWindow, policyVersion: policy.policyVersion, explanation: policy.explanation
          },
          ...(paid
            ? {
                paymentStatus: plan.refundable ? 'refunded' : 'paid',
                refund: {
                  id: outcome.refund?.id || '',
                  amount: plan.refundAmount,
                  status: outcome.ok ? (outcome.refund?.status || (booking.paymentMethod === 'razorpay' ? 'requested' : 'manual')) : 'failed',
                  processedAt: new Date(),
                  note: outcome.ok ? plan.note : (outcome.reason || 'The refund could not be processed automatically.')
                }
              }
            : {})
        }
      },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'This booking request has already been processed.' });

    const agreement = await Agreement.findOne({ bookingId: booking._id });
    if (agreement) {
      agreement.acceptedByOwner = false;
      agreement.ownerAcceptedAt = null;
      agreement.agreementStatus = 'rejected';
      agreement.ownerDecisionReason = reason;
      await agreement.save();
    }
    if (plan.refundable) await markPaymentRefunded(booking.razorpayPaymentId || booking.paymentReference, plan.refundAmount);
    await releaseBookingSlot(updated);
    await notifyUser(updated.userId, {
      type: 'booking',
      title: 'Booking request declined',
      message: `The owner declined your request${reason ? `: ${reason}` : '.'} ${plan.refundable ? `₹${plan.refundAmount} is refunded.` : 'No payment had been collected.'}`,
      data: { bookingId: updated._id.toString() }
    });
    res.json({
      success: true,
      message: outcome.ok
        ? `Booking request rejected. ${plan.refundable ? `₹${plan.refundAmount} is refunded to the renter.` : 'No payment had been collected.'}`
        : 'Booking request rejected, but the automatic refund failed and must be processed manually.',
      booking: { ...updated.toObject(), id: updated._id.toString() },
      refund: { ...plan, gateway: outcome.refund, gatewayError: outcome.ok ? null : outcome.reason }
    });
  } catch (error) {
    console.error('[bookings] owner decision failed:', error.message);
    res.status(500).json({ message: 'Booking decision could not be saved. Please try again.' });
  }
});

router.get('/my', requireAuth, async (req, res) => {
  try {
    const bookings = await Booking.find({ userId: req.user._id }).populate('vehicleId', 'name type category location image vehiclePicture price priceUnit numberPlate fuelType currentKm transmission').sort({ createdAt: -1 }).lean();
    res.json(bookings.map(booking => ({ ...booking, id: idOf(booking._id), userId: idOf(booking.userId), ownerId: idOf(booking.ownerId), quote: quoteFromBooking(booking), vehicleId: booking.vehicleId ? { ...booking.vehicleId, id: idOf(booking.vehicleId), category: booking.vehicleId.category || booking.vehicleId.type } : null })));
  } catch (error) { res.status(500).json({ message: 'Your bookings could not be loaded.' }); }
});

router.get('/my-agreements', requireAuth, async (req, res) => {
  try {
    const bookings = await Booking.find({ userId: req.user._id }).select('_id').lean();
    const agreements = await Agreement.find({ bookingId: { $in: bookings.map(booking => booking._id) } }).sort({ createdAt: -1 }).lean();
    res.json(agreements.map(agreement => ({ ...agreement, id: idOf(agreement._id), bookingId: idOf(agreement.bookingId) })));
  } catch (error) { res.status(500).json({ message: 'Your agreements could not be loaded.' }); }
});

// Note: admin booking listings live in routes/admin.js (GET /api/admin/bookings).
// Do not re-add a duplicate admin route here.
router.get('/:id/agreement/details', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  try {
    const booking = await Booking.findById(req.params.id).populate('userId', 'name email phone').populate({ path: 'vehicleId', select: 'name type category location price priceUnit numberPlate ownerId fuelType currentKm', populate: { path: 'ownerId', select: 'name email phone' } });
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    const renterId = idOf(booking.userId?._id || booking.userId);
    const ownerId = idOf(booking.vehicleId?.ownerId?._id || booking.vehicleId?.ownerId);
    const isRenter = renterId === idOf(req.user._id); const isOwner = ownerId === idOf(req.user._id);
    if (req.user.role !== 'admin' && !isRenter && !isOwner) return res.status(403).json({ message: 'You do not have permission to view this agreement.' });
    const agreement = await Agreement.findOne({ bookingId: booking._id });
    if (!agreement) return res.status(404).json({ message: 'Agreement unavailable for this booking.' });
    res.json({ ...agreement.toObject(), id: agreement._id.toString(), bookingId: idOf(booking._id), booking: { id: idOf(booking._id), bookingDate: booking.createdAt, startDate: booking.startDate, endDate: booking.endDate, hours: booking.hours, estimatedKm: booking.estimatedKm, pickupLocation: booking.vehicleId?.location || '', returnLocation: booking.vehicleId?.location || '', quote: quoteFromBooking(booking), paymentStatus: booking.paymentStatus, status: booking.status, paymentMethod: booking.paymentMethod }, renter: { name: booking.userId?.name || '', email: booking.userId?.email || '', phone: booking.userId?.phone || '' }, owner: { name: booking.vehicleId?.ownerId?.name || '', email: booking.vehicleId?.ownerId?.email || '', phone: booking.vehicleId?.ownerId?.phone || '' }, vehicle: { name: booking.vehicleId?.name || '', type: booking.vehicleId?.type || '', category: booking.vehicleId?.category || '', fuelType: booking.vehicleId?.fuelType || '', location: booking.vehicleId?.location || '', price: booking.vehicleId?.price || 0, numberPlate: booking.vehicleId?.numberPlate || '' }, canOwnerAccept: Boolean((isOwner || req.user.role === 'admin') && !agreement.acceptedByOwner), canUserSign: Boolean((isRenter || req.user.role === 'admin') && !agreement.acceptedByUser), fullySigned: Boolean(agreement.acceptedByUser && agreement.acceptedByOwner) });
  } catch (error) { res.status(500).json({ message: error.message || 'Agreement could not be loaded.' }); }
});

router.post('/:id/agreement/owner-accept', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  try {
    const booking = await Booking.findById(req.params.id).populate('vehicleId', 'ownerId');
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    if (req.user.role !== 'admin' && idOf(booking.vehicleId?.ownerId) !== idOf(req.user._id)) return res.status(403).json({ message: 'Only the vehicle owner can accept this agreement.' });
    if (!['pending_owner', 'confirmed'].includes(booking.status)) return res.status(409).json({ message: 'This agreement is no longer awaiting owner action.' });
    const agreement = await createAgreement(booking._id);
    agreement.acceptedByOwner = true; agreement.ownerAcceptedAt = new Date(); agreement.agreementStatus = agreement.acceptedByUser ? 'approved' : 'pending_user'; await agreement.save();
    if (booking.status === 'pending_owner' && booking.paymentStatus === 'paid') {
      const confirmed = await Booking.findOneAndUpdate({ _id: booking._id, status: 'pending_owner' }, { $set: { status: 'confirmed', ownerDecision: { decision: 'approved', reason: '', decidedAt: new Date(), decidedBy: req.user._id } } }, { returnDocument: 'after' });
      if (confirmed) {
        await applyEarningsDelta(confirmed, 1);
        await notifyUser(confirmed.userId, { type: 'booking', title: 'Booking approved', message: 'The owner approved your rental request.', data: { bookingId: confirmed._id.toString() } });
      }
    }
    res.json({ success: true, message: 'Owner agreement accepted.', agreement: { ...agreement.toObject(), id: agreement._id.toString() }, fullySigned: agreement.acceptedByUser && agreement.acceptedByOwner });
  } catch (error) { res.status(500).json({ message: 'Owner acceptance could not be saved.' }); }
});

router.post('/:id/agreement/user-sign', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    if (idOf(booking.userId) !== idOf(req.user._id) && req.user.role !== 'admin') return res.status(403).json({ message: 'Only the renter can sign this agreement.' });
    const agreement = await createAgreement(booking._id);
    agreement.acceptedByUser = true; agreement.acceptedAt = new Date(); agreement.agreementStatus = agreement.acceptedByOwner ? 'approved' : 'pending_owner'; await agreement.save();
    booking.agreementAcceptedAt = booking.agreementAcceptedAt || new Date(); await booking.save();
    res.json({ success: true, message: 'Renter agreement accepted.', agreement: { ...agreement.toObject(), id: agreement._id.toString() }, fullySigned: agreement.acceptedByUser && agreement.acceptedByOwner });
  } catch (error) { res.status(500).json({ message: 'Renter acceptance could not be saved.' }); }
});

router.get('/:id/agreement', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  try {
    const booking = await Booking.findById(req.params.id).populate('vehicleId', 'ownerId');
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    const isRenter = idOf(booking.userId) === idOf(req.user._id); const isOwner = idOf(booking.vehicleId?.ownerId) === idOf(req.user._id);
    if (req.user.role !== 'admin' && !isRenter && !isOwner) return res.status(403).json({ message: 'You do not have permission to download this agreement.' });
    const agreement = await Agreement.findOne({ bookingId: booking._id });
    if (!agreement) return res.status(404).json({ message: 'Agreement unavailable for this booking.' });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${agreement.agreementId}.pdf"`); res.send(makeAgreementPdf(agreement.toObject()));
  } catch (error) { res.status(500).json({ message: 'Agreement PDF could not be generated.' }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  const booking = await Booking.findById(req.params.id).populate('vehicleId').lean();
  if (!booking) return res.status(404).json({ message: 'Booking not found.' });
  if (req.user.role !== 'admin' && idOf(booking.userId) !== idOf(req.user._id) && idOf(booking.vehicleId?.ownerId) !== idOf(req.user._id)) return res.status(403).json({ message: 'You do not have permission to view this booking.' });
  res.json({ ...booking, id: idOf(booking._id), quote: quoteFromBooking(booking) });
});

module.exports = router;

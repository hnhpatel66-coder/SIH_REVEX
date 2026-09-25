const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const https = require('https');
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
  ['Cancellation', 'A booking may be cancelled according to the displayed status. Paid demo payments are not automatically refunded; a real gateway would require its refund flow.'],
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
    taxPercent: Number(booking.taxPercent || 0),
    taxFees: Number(booking.taxFees || 0),
    subtotal: Number(booking.subtotal || 0),
    grandTotal: Number(booking.grandTotal ?? booking.totalAmount ?? 0),
    paidAmount: Number(booking.paidAmount ?? (booking.paymentStatus === 'paid' ? (booking.grandTotal ?? booking.totalAmount ?? 0) : 0)),
    remainingAmount: Number(booking.remainingAmount ?? (booking.paymentStatus === 'paid' ? 0 : (booking.grandTotal ?? booking.totalAmount ?? 0))),
    pricingVersion: booking.pricingSnapshot?.pricingVersion || 'revex-pricing-v2'
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
    baseAmount: booking.baseAmount || 0, additionalCharges: booking.additionalCharges || 0, extraKilometerCharges: booking.extraKilometerCharges || 0,
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

function escapePdfText(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
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
    'PAYMENT BREAKDOWN', `Base rental amount: Rs. ${agreement.baseAmount || agreement.rentalAmount || 0}`, `Additional charges: Rs. ${agreement.additionalCharges || 0}`, `Extra kilometre charges: Rs. ${agreement.extraKilometerCharges || 0}`, `Tax / fees: Rs. ${agreement.taxFees || 0}`, `Grand total: Rs. ${agreement.grandTotal || agreement.rentalAmount || 0}`, `Payment status: ${agreement.paymentStatus}`, '',
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
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content.join('\n'))} >>\nstream\n${content.join('\n')}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets[index + 1] = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}

function razorpayConfigured() { return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET); }
function razorpayRequest(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const payload = body ? JSON.stringify(body) : '';
    const request = https.request({ hostname: 'api.razorpay.com', path: requestPath, method, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        let parsed = {}; try { parsed = JSON.parse(data); } catch {}
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed); else reject(new Error(parsed.error?.description || `Payment gateway error (${response.statusCode}).`));
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function recordPayment(booking, method, reference, providerData = {}) {
  try {
    await Payment.create({ bookingId: booking._id, userId: booking.userId, vehicleId: booking.vehicleId, amount: booking.grandTotal || booking.totalAmount, currency: 'INR', method, status: 'paid', reference, providerData, paidAt: new Date() });
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
      extraKilometerCharges: quote.extraKilometerCharges, additionalCharges: quote.additionalCharges, taxPercent: quote.taxPercent, taxFees: quote.taxFees,
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
  if (!razorpayConfigured()) return res.status(503).json({ message: 'Online payment is not configured. Use the available payment method or contact support.' });
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user._id, status: 'payment_pending', paymentStatus: 'pending' });
    if (!booking) return res.status(404).json({ message: 'Booking is no longer awaiting payment.' });
    const order = await razorpayRequest('POST', '/v1/orders', { amount: Math.round((booking.grandTotal || booking.totalAmount) * 100), currency: 'INR', receipt: `REVEX-${booking._id}` });
    booking.paymentMethod = 'razorpay'; booking.razorpayOrderId = order.id; await booking.save();
    res.json({ order, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (error) { res.status(502).json({ message: error.message || 'Payment gateway could not create an order.' }); }
});

router.post('/:id/payment-demo', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user._id, status: 'payment_pending', paymentStatus: 'pending' });
    if (!booking) return res.status(404).json({ message: 'Booking is no longer awaiting payment.' });
    const agreement = await Agreement.findOne({ bookingId: booking._id });
    if (!agreement?.acceptedByUser) return res.status(403).json({ message: 'Accept the Rental Agreement and Terms & Conditions before payment.' });
    const reference = `REVEX-DEMO-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    const updated = await Booking.findOneAndUpdate({ _id: booking._id, userId: req.user._id, status: 'payment_pending', paymentStatus: 'pending' }, { paymentStatus: 'paid', paidAmount: booking.grandTotal, remainingAmount: 0, status: 'pending_owner', paymentMethod: 'demo', paymentReference: reference }, { returnDocument: 'after' });
    if (!updated) return res.status(409).json({ message: 'Booking state changed. Please refresh your bookings.' });
    await recordPayment(updated, 'demo', reference);
    const savedAgreement = await createAgreement(updated._id);
    await notifyUser(updated.ownerId, { type: 'payment', title: 'Booking payment received', message: `Payment received for booking ${updated._id}. Please review the request.`, data: { bookingId: updated._id.toString() } });
    res.json({ success: true, message: 'Payment successful. Your request is now waiting for owner approval.', booking: { ...updated.toObject(), id: updated._id.toString(), quote: quoteFromBooking(updated) }, agreement: savedAgreement.toObject(), paymentReference: reference });
  } catch (error) { res.status(500).json({ message: error.message || 'Payment could not be completed.' }); }
});

router.post('/:id/verify-payment', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  if (!razorpayConfigured()) return res.status(503).json({ message: 'Razorpay is not configured on this server.' });
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user._id });
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    if (booking.paymentStatus === 'paid') return res.json({ success: true, message: 'Payment already verified.', booking: { ...booking.toObject(), id: booking._id.toString(), quote: quoteFromBooking(booking) }, agreement: await createAgreement(booking._id) });
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
    if (!orderId || !paymentId || !signature) return res.status(400).json({ message: 'Payment verification data is incomplete.' });
    if (orderId !== booking.razorpayOrderId) return res.status(400).json({ message: 'Payment order does not match this booking.' });
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    if (signature.length !== expected.length || !/^[a-f0-9]+$/i.test(signature) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      await Booking.findByIdAndUpdate(booking._id, { paymentStatus: 'failed', status: 'cancelled' });
      await releaseBookingSlot(booking);
      return res.status(400).json({ message: 'Payment verification failed. Booking was not confirmed.' });
    }
    const updated = await Booking.findOneAndUpdate({ _id: booking._id, userId: req.user._id, status: 'payment_pending' }, { paymentStatus: 'paid', paidAmount: booking.grandTotal, remainingAmount: 0, status: 'pending_owner', razorpayPaymentId: paymentId, razorpaySignature: signature }, { returnDocument: 'after' });
    if (!updated) return res.status(409).json({ message: 'Booking state changed. Please refresh your bookings.' });
    await recordPayment(updated, 'razorpay', paymentId, { orderId, signature });
    const agreement = await createAgreement(updated._id);
    res.json({ success: true, message: 'Payment verified. Your request is waiting for owner approval.', booking: { ...updated.toObject(), id: updated._id.toString(), quote: quoteFromBooking(updated) }, agreement: agreement.toObject() });
  } catch (error) { res.status(500).json({ message: error.message || 'Payment verification failed.' }); }
});

router.post('/:id/payment-failed', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  const booking = await Booking.findOneAndUpdate({ _id: req.params.id, userId: req.user._id, status: 'payment_pending' }, { paymentStatus: 'failed', status: 'cancelled' }, { returnDocument: 'after' });
  if (!booking) return res.status(404).json({ message: 'Booking cannot be marked as failed.' });
  await releaseBookingSlot(booking);
  res.json({ success: true, message: 'Payment failed. Your booking was not confirmed.' });
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  const booking = await Booking.findOne({ _id: req.params.id, userId: req.user._id, status: { $in: ['pending', 'payment_pending', 'pending_owner', 'confirmed'] } });
  if (!booking) return res.status(404).json({ message: 'This booking cannot be cancelled.' });
  booking.status = 'cancelled'; await booking.save(); await releaseBookingSlot(booking);
  await notifyUser(booking.ownerId, { type: 'booking', title: 'Booking cancelled', message: `The renter cancelled booking ${booking._id}.`, data: { bookingId: booking._id.toString() } });
  res.json({ success: true, message: booking.paymentStatus === 'paid' ? 'Booking cancelled. Any refund must follow the payment provider process.' : 'Booking cancelled.', booking: { ...booking.toObject(), id: booking._id.toString() } });
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
    if (req.query.status) query.status = req.query.status; else query.status = { $in: ['payment_pending', 'pending_owner', 'confirmed', 'completed', 'rejected'] };
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
    const nextStatus = decision === 'approve' ? 'confirmed' : 'rejected';
    const updated = await Booking.findOneAndUpdate({ _id: booking._id, status: 'pending_owner' }, { $set: { status: nextStatus, ownerDecision: { decision: decision === 'approve' ? 'approved' : 'rejected', reason, decidedAt: new Date(), decidedBy: req.user._id } } }, { returnDocument: 'after' });
    if (!updated) return res.status(409).json({ message: 'This booking request has already been processed.' });
    const agreement = await Agreement.findOne({ bookingId: booking._id });
    if (agreement) {
      agreement.acceptedByOwner = decision === 'approve';
      agreement.ownerAcceptedAt = decision === 'approve' ? new Date() : null;
      agreement.agreementStatus = decision === 'approve' ? 'approved' : 'rejected';
      agreement.ownerDecisionReason = reason;
      await agreement.save();
    }
    if (decision === 'approve') {
      const ownerShare = Math.round((updated.grandTotal || updated.totalAmount || 0) * 0.9);
      await Vehicle.findByIdAndUpdate(updated.vehicleId, { $inc: { totalEarnings: ownerShare, totalRentals: 1 } });
      await User.findByIdAndUpdate(updated.ownerId || booking.vehicleId?.ownerId, { $inc: { ownerEarnings: ownerShare } });
    } else {
      await releaseBookingSlot(updated);
    }
    await notifyUser(updated.userId, { type: 'booking', title: decision === 'approve' ? 'Booking approved' : 'Booking request declined', message: decision === 'approve' ? 'The owner approved your rental request.' : `The owner declined your request${reason ? `: ${reason}` : '.'}`, data: { bookingId: updated._id.toString() } });
    res.json({ success: true, message: decision === 'approve' ? 'Booking request approved.' : 'Booking request rejected.', booking: { ...updated.toObject(), id: updated._id.toString() } });
  } catch (error) { res.status(500).json({ message: 'Booking decision could not be saved. Please try again.' }); }
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

router.get('/admin/all', requireAuth, requireRole('admin'), async (req, res) => {
  const bookings = await Booking.find({}).populate('userId', 'name email').populate('vehicleId', 'name type category location').sort({ createdAt: -1 }).lean();
  res.json(bookings.map(booking => ({ ...booking, id: idOf(booking._id) })));
});

router.get('/:id/agreement/details', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  try {
    const booking = await Booking.findById(req.params.id).populate('userId', 'name email phone').populate({ path: 'vehicleId', select: 'name type category location price priceUnit numberPlate ownerId fuelType currentKm', populate: { path: 'ownerId', select: 'name email phone' } });
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    const renterId = idOf(booking.userId?._id || booking.userId);
    const ownerId = idOf(booking.vehicleId?.ownerId?._id || booking.vehicleId?.ownerId);
    const isRenter = renterId === idOf(req.user._id); const isOwner = ownerId === idOf(req.user._id);
    if (req.user.role !== 'admin' && !isRenter && !isOwner) return res.status(403).json({ message: 'You do not have permission to view this agreement.' });
    const agreement = await createAgreement(booking._id);
    res.json({ ...agreement.toObject(), id: agreement._id.toString(), bookingId: idOf(booking._id), booking: { id: idOf(booking._id), bookingDate: booking.createdAt, startDate: booking.startDate, endDate: booking.endDate, hours: booking.hours, estimatedKm: booking.estimatedKm, pickupLocation: booking.vehicleId?.location || '', returnLocation: booking.vehicleId?.location || '', quote: quoteFromBooking(booking), paymentStatus: booking.paymentStatus, status: booking.status, paymentMethod: booking.paymentMethod }, renter: { name: booking.userId?.name || '', email: booking.userId?.email || '', phone: booking.userId?.phone || '' }, owner: { name: booking.vehicleId?.ownerId?.name || '', email: booking.vehicleId?.ownerId?.email || '', phone: booking.vehicleId?.ownerId?.phone || '' }, vehicle: { name: booking.vehicleId?.name || '', type: booking.vehicleId?.type || '', category: booking.vehicleId?.category || '', fuelType: booking.vehicleId?.fuelType || '', location: booking.vehicleId?.location || '', price: booking.vehicleId?.price || 0, numberPlate: booking.vehicleId?.numberPlate || '' }, canOwnerAccept: Boolean((isOwner || req.user.role === 'admin') && !agreement.acceptedByOwner), canUserSign: Boolean((isRenter || req.user.role === 'admin') && !agreement.acceptedByUser), fullySigned: Boolean(agreement.acceptedByUser && agreement.acceptedByOwner) });
  } catch (error) { res.status(500).json({ message: error.message || 'Agreement could not be loaded.' }); }
});

router.post('/:id/agreement/owner-accept', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Booking not found.' });
  try {
    const booking = await Booking.findById(req.params.id).populate('vehicleId', 'ownerId');
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    if (req.user.role !== 'admin' && idOf(booking.vehicleId?.ownerId) !== idOf(req.user._id)) return res.status(403).json({ message: 'Only the vehicle owner can accept this agreement.' });
    const agreement = await createAgreement(booking._id);
    agreement.acceptedByOwner = true; agreement.ownerAcceptedAt = new Date(); agreement.agreementStatus = agreement.acceptedByUser ? 'approved' : 'pending_user'; await agreement.save();
    if (booking.status === 'pending_owner' && booking.paymentStatus === 'paid') {
      const confirmed = await Booking.findOneAndUpdate({ _id: booking._id, status: 'pending_owner' }, { $set: { status: 'confirmed', ownerDecision: { decision: 'approved', reason: '', decidedAt: new Date(), decidedBy: req.user._id } } }, { returnDocument: 'after' });
      if (confirmed) {
        const ownerShare = Math.round((confirmed.grandTotal || confirmed.totalAmount || 0) * 0.9);
        await Vehicle.findByIdAndUpdate(confirmed.vehicleId, { $inc: { totalEarnings: ownerShare, totalRentals: 1 } });
        await User.findByIdAndUpdate(confirmed.ownerId || booking.vehicleId?.ownerId, { $inc: { ownerEarnings: ownerShare } });
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
    const agreement = await createAgreement(booking._id);
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

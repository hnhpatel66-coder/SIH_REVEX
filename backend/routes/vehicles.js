const express = require('express');
const mongoose = require('mongoose');
const Vehicle = require('../models/Vehicle');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');
const {
  CATEGORY_VALUES,
  FUEL_VALUES,
  PRICE_UNITS,
  calculateRentalQuote,
  normalizeCategory,
  normalizeFuelType,
  normalizePlate,
  normalizePriceUnit,
  suggestRentalPrice
} = require('../utils/pricing');
const { normalizeMediaUrl } = require('../utils/media');
const { deleteVehicleCascade, summarise } = require('../utils/hardDelete');
const Booking = require('../models/Booking');

const router = express.Router();

// Upload budget shared with js/owner.js. Data URLs are base64 (≈33% larger than
// the raw file), so the encoded limits are ~1.4x the advertised file size.
const UPLOAD_LIMITS = {
  photoMb: 2,
  documentMb: 0.8,
  maxDocuments: 6,
  photoBytes: 2 * 1024 * 1024,
  documentBytes: 0.8 * 1024 * 1024
};
const demoImages = [
  'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=900&q=80'
];

function idOf(value) {
  if (!value) return '';
  if (typeof value === 'object') return String(value._id || value.id || '');
  return String(value);
}

function normalizedStatus(vehicle) {
  if (vehicle.status === 'available') return 'approved';
  if (vehicle.status === 'unavailable') return 'removed';
  return vehicle.status || 'pending';
}

function statusLabel(status) {
  return ({ pending: 'Pending Approval', approved: 'Approved', rejected: 'Rejected', removed: 'Removed (legacy)' })[status] || 'Pending Approval';
}

function serialize(vehicle, { admin = false } = {}) {
  const value = vehicle && typeof vehicle.toObject === 'function' ? vehicle.toObject() : { ...(vehicle || {}) };
  const owner = value.ownerId && typeof value.ownerId === 'object' ? value.ownerId : null;
  const status = normalizedStatus(value);
  const result = {
    ...value,
    id: idOf(value._id || value.id),
    ownerId: idOf(value.ownerId),
    category: value.category || normalizeCategory(value.type),
    type: value.type || value.category || normalizeCategory(value.category),
    fuelType: normalizeFuelType(value.fuelType),
    status,
    statusLabel: statusLabel(status),
    availability: value.availability || (status === 'approved' ? 'available' : 'unavailable'),
    image: normalizeMediaUrl(value.image || value.vehiclePicture, demoImages[0]),
    vehiclePicture: normalizeMediaUrl(value.vehiclePicture || value.image, demoImages[0]),
    owner: owner ? { id: idOf(owner), name: owner.name || 'Vehicle owner' } : undefined
  };
  if (admin) {
    result.documents = Array.isArray(value.documents) ? value.documents : [];
    result.numberPlateNormalized = value.numberPlateNormalized || '';
  } else {
    delete result.documents;
    delete result.ownershipPaper;
    delete result.insurance;
    delete result.puc;
    delete result.numberPlateNormalized;
    delete result.totalEarnings;
    delete result.totalRentals;
    delete result.reviewedBy;
    delete result.ownerId;
  }
  delete result._id;
  delete result.__v;
  return result;
}

function isPublicVehicle(vehicle) {
  return vehicle && normalizedStatus(vehicle) === 'approved' && vehicle.verified !== false && (vehicle.availability || 'available') !== 'unavailable';
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function validImage(value) {
  if (!value) return true;
  if (typeof value !== 'string') return false;
  return /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(value) || /^https?:\/\//i.test(value) || /^\/?(uploads|images|assets)\//i.test(value);
}

function parseDocuments(body) {
  const documents = [];
  const incoming = Array.isArray(body.documents) ? body.documents : [];
  for (const item of incoming.slice(0, 6)) {
    const type = ['ownership', 'insurance', 'puc', 'id', 'other'].includes(item.type) ? item.type : 'other';
    const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl : '';
    if (dataUrl && (!/^data:(image\/|application\/pdf)/i.test(dataUrl) || dataUrl.length > UPLOAD_LIMITS.documentBytes * 1.4)) {
      throw Object.assign(new Error(`${item.label || 'Vehicle document'} could not be uploaded. Use an image or PDF smaller than ${UPLOAD_LIMITS.documentMb} MB.`), { statusCode: 400 });
    }
    documents.push({
      type,
      label: text(item.label || type, 80),
      fileName: text(item.fileName, 160),
      mimeType: text(item.mimeType, 100),
      dataUrl,
      size: Number(item.size) || (dataUrl ? Math.round(dataUrl.length * 0.75) : 0),
      status: 'pending',
      uploadedAt: new Date()
    });
  }
  // Preserve legacy clients which send only a file name.
  for (const [type, label, value] of [
    ['ownership', 'Ownership papers', body.ownershipPaper],
    ['insurance', 'Insurance', body.insurance],
    ['puc', 'PUC certificate', body.puc]
  ]) {
    if (value && !documents.some(doc => doc.type === type)) {
      const dataUrl = typeof value === 'string' && /^data:(image\/|application\/pdf)/i.test(value) && value.length <= UPLOAD_LIMITS.documentBytes * 1.4 ? value : '';
      documents.push({ type, label, fileName: dataUrl ? '' : text(value, 160), mimeType: dataUrl ? value.split(';')[0] : '', dataUrl, size: dataUrl ? Math.round(dataUrl.length * 0.75) : 0, status: 'pending', uploadedAt: new Date() });
    }
  }
  return documents;
}

function parseVehiclePayload(body, existing = {}) {
  const rawCategory = body.category ?? body.type ?? existing.category ?? existing.type;
  const categoryText = String(rawCategory || '').trim().toLowerCase();
  const categoryAliases = { car: 'Car', cars: 'Car', bike: 'Bike', bikes: 'Bike', motorcycle: 'Bike', scooter: 'Scooter', scooters: 'Scooter', other: 'Other' };
  const category = categoryAliases[categoryText];
  if (!category) throw Object.assign(new Error('Choose a valid vehicle category (Car, Bike, Scooter or Other).'), { statusCode: 400 });
  const rawFuel = String(body.fuelType ?? existing.fuelType ?? 'Petrol').trim().toLowerCase();
  if (rawFuel && !FUEL_VALUES.some(value => value.toLowerCase() === rawFuel)) throw Object.assign(new Error('Choose a valid fuel type.'), { statusCode: 400 });
  const fuelType = normalizeFuelType(rawFuel);
  const rawPriceUnit = String(body.priceUnit ?? existing.priceUnit ?? 'hour').trim().toLowerCase();
  if (rawPriceUnit && !PRICE_UNITS.includes(rawPriceUnit)) throw Object.assign(new Error('Choose a valid price unit (hour, day or km).'), { statusCode: 400 });
  const priceUnit = normalizePriceUnit(rawPriceUnit);
  const name = text(body.name ?? existing.name, 120);
  const location = text(body.location ?? existing.location, 200);
  if (!name || !location) throw Object.assign(new Error('Vehicle name and pickup location are required.'), { statusCode: 400 });
  const price = Number(body.price ?? existing.price);
  if (!Number.isFinite(price) || price < 1) throw Object.assign(new Error('Enter a valid rental price greater than zero.'), { statusCode: 400 });
  const currentKm = Number(body.currentKm ?? body.kilometer ?? existing.currentKm ?? 0);
  if (!Number.isFinite(currentKm) || currentKm < 0 || currentKm > 70000) throw Object.assign(new Error('Current kilometer must be between 0 and 70,000 km.'), { statusCode: 400 });
  const numeric = (value, fallback, label, min, max) => { const number = value === undefined || value === null || value === '' ? fallback : Number(value); if (!Number.isFinite(number) || number < min || number > max) throw Object.assign(new Error(`${label} must be a number between ${min} and ${max}.`), { statusCode: 400 }); return number; };
  const rawImage = body.vehiclePicture ?? body.image ?? existing.vehiclePicture ?? existing.image ?? '';
  if (typeof rawImage === 'string' && rawImage.length > UPLOAD_LIMITS.photoBytes * 1.4) throw Object.assign(new Error(`Vehicle photo is too large. Please use an image smaller than ${UPLOAD_LIMITS.photoMb} MB.`), { statusCode: 400 });
  const image = String(rawImage || '').trim();
  if (!validImage(image)) throw Object.assign(new Error('Vehicle photo must be a valid image, upload path or HTTP(S) URL.'), { statusCode: 400 });
  const normalizedImage = normalizeMediaUrl(image, '');
  const availableFromRaw = body.availableFrom ?? body.available ?? existing.availableFrom;
  let availableFrom = existing.availableFrom;
  if (availableFromRaw) {
    availableFrom = new Date(availableFromRaw);
    if (Number.isNaN(availableFrom.getTime())) throw Object.assign(new Error('Enter a valid availability date.'), { statusCode: 400 });
  }
  return {
    name,
    category,
    type: category,
    brand: text(body.brand ?? existing.brand, 80),
    model: text(body.model ?? existing.model, 80),
    location,
    description: text(body.description ?? existing.description, 2000),
    fuelType,
    transmission: ['Manual', 'Automatic', 'Other'].includes(body.transmission) ? body.transmission : (existing.transmission || 'Manual'),
    price,
    priceUnit,
    currentKm,
    includedKm: numeric(body.includedKm, Number(existing.includedKm ?? 300), 'Included kilometres', 0, 100000),
    extraKmRate: numeric(body.extraKmRate, Number(existing.extraKmRate ?? 10), 'Extra kilometre charge', 0, 10000),
    additionalCharges: numeric(body.additionalCharges, Number(existing.additionalCharges ?? 0), 'Additional charges', 0, 1000000),
    discountPercent: numeric(body.discountPercent, Number(existing.discountPercent ?? 0), 'Discount', 0, 100),
    taxPercent: numeric(body.taxPercent, Number(existing.taxPercent ?? 0), 'Tax / fees', 0, 100),
    availableFrom,
    image: normalizedImage || demoImages[0],
    vehiclePicture: normalizedImage || demoImages[0]
  };
}

async function syncOwnerCounters(ownerId) {
  const [fleetCount, approvedCount, pendingCount, rejectedCount, removedCount] = await Promise.all([
    Vehicle.countDocuments({ ownerId }),
    Vehicle.countDocuments({ ownerId, status: 'approved' }),
    Vehicle.countDocuments({ ownerId, status: 'pending' }),
    Vehicle.countDocuments({ ownerId, status: 'rejected' }),
    Vehicle.countDocuments({ ownerId, status: 'removed' })
  ]);
  const User = require('../models/User');
  const status = approvedCount ? 'approved' : pendingCount ? 'pending' : rejectedCount ? 'rejected' : removedCount ? 'removed' : 'pending';
  await User.findByIdAndUpdate(ownerId, { $set: { totalCarsOnRent: fleetCount, carApprovalStatus: status } });
}

function duplicateMessage() {
  return 'A vehicle with this number plate already exists.';
}

async function findDuplicatePlate(plate, excludeId = null) {
  const normalized = normalizePlate(plate);
  if (!normalized) return null;
  const candidates = await Vehicle.find({ $or: [{ numberPlate: { $exists: true, $ne: '' } }, { numberPlateNormalized: { $exists: true, $ne: '' } }] }).select('_id numberPlate numberPlateNormalized');
  return candidates.find(item => normalizePlate(item.numberPlateNormalized || item.numberPlate) === normalized && (!excludeId || String(item._id) !== String(excludeId))) || null;
}

router.get('/price-suggestion', (req, res) => {
  try {
    const suggestion = suggestRentalPrice({ kilometers: req.query.kilometers, category: req.query.category, fuelType: req.query.fuelType });
    res.json(suggestion);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.get('/', optionalAuth, async (req, res) => {
  try {
    const requestedStatus = String(req.query.status || '').toLowerCase();
    const isAdmin = req.user?.role === 'admin';
    if (requestedStatus && !['all', 'approved', 'pending', 'rejected', 'removed', 'available', 'unavailable'].includes(requestedStatus)) {
      return res.status(400).json({ message: 'Invalid vehicle status filter.' });
    }
    if (requestedStatus && requestedStatus !== 'approved' && requestedStatus !== 'available' && !isAdmin) {
      return res.status(403).json({ message: 'Admin access is required to view non-public vehicle statuses.' });
    }
    const query = {};
    if (requestedStatus === 'all') {
      if (!isAdmin) return res.status(403).json({ message: 'Admin access is required.' });
    } else if (requestedStatus === 'approved' || requestedStatus === 'available') {
      query.status = { $in: ['approved', 'available'] };
      query.verified = true;
      query.availability = { $ne: 'unavailable' };
      query.$and = [{ $or: [{ availableFrom: { $exists: false } }, { availableFrom: null }, { availableFrom: { $lte: new Date() } }] }];
    } else if (requestedStatus) {
      query.status = requestedStatus;
    } else {
      query.status = { $in: ['approved', 'available'] };
      query.verified = true;
      query.availability = { $ne: 'unavailable' };
      query.$and = [{ $or: [{ availableFrom: { $exists: false } }, { availableFrom: null }, { availableFrom: { $lte: new Date() } }] }];
    }
    if (req.query.location) query.location = { $regex: text(req.query.location, 100), $options: 'i' };
    if (req.query.category || req.query.type) query.$or = [{ category: normalizeCategory(req.query.category || req.query.type) }, { type: normalizeCategory(req.query.category || req.query.type) }];
    if (req.query.fuelType) query.fuelType = normalizeFuelType(req.query.fuelType);
    if (req.query.maxPrice && Number.isFinite(Number(req.query.maxPrice))) query.price = { $lte: Number(req.query.maxPrice) };
    const docs = await Vehicle.find(query).populate('ownerId', 'name').sort({ createdAt: -1 }).lean();
    res.json(docs.map(doc => serialize(doc)));
  } catch (error) {
    res.status(500).json({ message: 'Vehicles could not be loaded. Please try again.' });
  }
});

router.get('/mine', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const query = req.user.role === 'admin' && req.query.all === 'true' ? {} : { ownerId: req.user._id };
    const docs = await Vehicle.find(query).populate('ownerId', 'name email phone').sort({ createdAt: -1 }).lean();
    res.json(docs.map(doc => serialize(doc, { admin: true })));
  } catch (error) {
    res.status(500).json({ message: 'Your vehicles could not be loaded. Please try again.' });
  }
});

router.get('/:id/quote', optionalAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that vehicle. Please try again.' });
  try {
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) return res.status(404).json({ message: 'We could not find that vehicle. Please try again.' });
    if (!isPublicVehicle(vehicle) && req.user?.role !== 'admin' && String(vehicle.ownerId) !== String(req.user?._id)) return res.status(404).json({ message: 'This vehicle is not available for booking.' });
    const quote = calculateRentalQuote({ vehicle, startDate: req.query.startDate, endDate: req.query.endDate, estimatedKm: req.query.estimatedKm });
    res.json({ vehicleId: String(vehicle._id), ...quote });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message || 'A valid booking time is required.' });
  }
});

router.get('/:id', optionalAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that vehicle. Please try again.' });
  try {
    const vehicle = await Vehicle.findById(req.params.id).populate('ownerId', 'name email phone').lean();
    if (!vehicle) return res.status(404).json({ message: 'We could not find that vehicle. Please try again.' });
    const canViewPrivate = req.user && (req.user.role === 'admin' || String(vehicle.ownerId?._id || vehicle.ownerId) === String(req.user._id));
    if (!isPublicVehicle(vehicle) && !canViewPrivate) return res.status(404).json({ message: 'This vehicle is not currently available.' });
    res.json(serialize(vehicle, { admin: canViewPrivate }));
  } catch (error) {
    res.status(500).json({ message: 'Vehicle details could not be loaded. Please try again.' });
  }
});

router.post('/', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const payload = parseVehiclePayload(req.body);
    const plate = text(req.body.numberPlate, 24);
    if (!plate || normalizePlate(plate).length < 5) return res.status(400).json({ message: 'Enter a valid vehicle number plate.' });
    if (await findDuplicatePlate(plate)) return res.status(409).json({ message: duplicateMessage() });
    const documents = parseDocuments(req.body);
    const ownerId = req.user.role === 'admin' && req.body.ownerId && mongoose.isValidObjectId(req.body.ownerId) ? req.body.ownerId : req.user._id;
    const vehicle = await Vehicle.create({
      ...payload,
      ownerId,
      numberPlate: plate.toUpperCase(),
      numberPlateNormalized: normalizePlate(plate),
      documents,
      ownershipPaper: req.body.ownershipPaper || '',
      insurance: req.body.insurance || '',
      puc: req.body.puc || '',
      status: 'pending',
      verified: false,
      availability: 'available',
      rating: 5,
      reviewCount: 0
    });
    await syncOwnerCounters(ownerId);
    res.status(201).json({ ...serialize(vehicle, { admin: true }), message: 'Vehicle saved. It is pending admin approval.' });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: duplicateMessage() });
    res.status(error.statusCode || 400).json({ message: error.message || 'Vehicle could not be saved. Please check the form.' });
  }
});

router.put('/:id', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that vehicle. Please try again.' });
  try {
    const existing = await Vehicle.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'We could not find that vehicle. Please try again.' });
    if (req.user.role !== 'admin' && String(existing.ownerId) !== String(req.user._id)) return res.status(403).json({ message: 'You can only edit your own vehicles.' });
    if (req.user.role !== 'admin' && existing.status === 'removed') return res.status(403).json({ message: 'This vehicle has been removed. Contact an admin if you need it restored.' });
    if (req.user.role !== 'admin' && Object.prototype.hasOwnProperty.call(req.body, 'numberPlate') && normalizePlate(req.body.numberPlate) !== normalizePlate(existing.numberPlate)) {
      return res.status(403).json({ message: 'Number plate changes require admin verification. Please contact support.' });
    }
    const payload = parseVehiclePayload(req.body, existing.toObject());
    const updates = { ...payload, type: payload.category, category: payload.category };
    if (req.user.role === 'admin') {
      if (Object.prototype.hasOwnProperty.call(req.body, 'numberPlate')) {
        const plate = text(req.body.numberPlate, 24);
        if (!plate || normalizePlate(plate).length < 5) return res.status(400).json({ message: 'Enter a valid vehicle number plate.' });
        if (await findDuplicatePlate(plate, existing._id)) return res.status(409).json({ message: duplicateMessage() });
        updates.numberPlate = plate.toUpperCase();
        updates.numberPlateNormalized = normalizePlate(plate);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'documents')) {
        const incomingDocs = parseDocuments(req.body);
        const existingDocs = (existing.documents || []).map(doc => (typeof doc.toObject === 'function' ? doc.toObject() : doc));
        const replacedTypes = new Set(incomingDocs.map(doc => doc.type));
        updates.documents = [...existingDocs.filter(doc => !replacedTypes.has(doc.type)), ...incomingDocs];
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
        const status = normalizedStatus({ status: req.body.status });
        if (!['pending', 'approved', 'rejected', 'removed'].includes(status)) return res.status(400).json({ message: 'Invalid vehicle moderation status.' });
        updates.status = status;
        updates.verified = status === 'approved';
        updates.availability = status === 'approved' ? 'available' : 'unavailable';
        updates.reviewedAt = new Date();
        updates.reviewedBy = req.user._id;
      }
    } else {
      if (Object.prototype.hasOwnProperty.call(req.body, 'documents')) {
        const incomingDocs = parseDocuments(req.body);
        const existingDocs = (existing.documents || []).map(doc => (typeof doc.toObject === 'function' ? doc.toObject() : doc));
        const replacedTypes = new Set(incomingDocs.map(doc => doc.type));
        updates.documents = [...existingDocs.filter(doc => !replacedTypes.has(doc.type)), ...incomingDocs];
      }
      // Any owner edit to a verified listing returns it to moderation rather
      // than silently changing a live listing.
      updates.status = 'pending';
      updates.verified = false;
      updates.availability = 'unavailable';
      updates.rejectionReason = '';
      updates.removalReason = '';
    }
    const updated = await Vehicle.findByIdAndUpdate(existing._id, updates, { returnDocument: 'after', runValidators: true });
    await syncOwnerCounters(existing.ownerId);
    res.json({ ...serialize(updated, { admin: true }), message: req.user.role === 'admin' ? 'Vehicle updated.' : 'Vehicle updated and sent for approval.' });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: duplicateMessage() });
    res.status(error.statusCode || 400).json({ message: error.message || 'Vehicle could not be updated.' });
  }
});

router.delete('/:id', requireAuth, requireRole('owner', 'admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'We could not find that vehicle. Please try again.' });
  try {
    const vehicle = await Vehicle.findById(req.params.id).select('name ownerId').lean();
    if (!vehicle) return res.status(404).json({ message: 'We could not find that vehicle. Please try again.' });
    if (req.user.role !== 'admin' && String(vehicle.ownerId) !== String(req.user._id)) {
      return res.status(403).json({ message: 'You can only delete your own vehicles.' });
    }
    const reason = text(req.body?.reason || (req.user.role === 'admin' ? '' : 'Removed by owner'), 1000);
    if (!reason) return res.status(400).json({ message: 'Enter a reason before deleting this vehicle.' });
    // Destructive and irreversible: the client must explicitly confirm.
    const confirmed = req.body?.confirm === true || req.body?.confirm === 'true';
    if (!confirmed) return res.status(400).json({ message: 'Deletion must be confirmed.', code: 'CONFIRMATION_REQUIRED' });

    const dependents = await Booking.countDocuments({ vehicleId: vehicle._id });
    const result = await deleteVehicleCascade(vehicle._id);
    if (!result.deleted) return res.status(404).json({ message: 'We could not find that vehicle. Please try again.' });
    await syncOwnerCounters(vehicle.ownerId);

    res.json({
      success: true,
      message: `${vehicle.name} was deleted permanently. ${summarise(result)}`,
      reason,
      dependents,
      counts: result.counts,
      deletedId: idOf(vehicle._id)
    });
  } catch (error) {
    console.error('[vehicles] delete failed:', error.message);
    res.status(500).json({ message: 'Vehicle could not be deleted. Please try again.' });
  }
});

module.exports = router;

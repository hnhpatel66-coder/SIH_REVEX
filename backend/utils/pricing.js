const CATEGORY_VALUES = ['Car', 'Bike', 'Scooter', 'Other'];
const FUEL_VALUES = ['Petrol', 'Diesel', 'Electric', 'CNG', 'Hybrid'];
const PRICE_UNITS = ['hour', 'day', 'km'];

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeCategory(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'Other';
  if (text === 'car' || text === 'cars' || text === 'automobile') return 'Car';
  if (text === 'bike' || text === 'bikes' || text === 'motorcycle') return 'Bike';
  if (text === 'scooter' || text === 'scooters') return 'Scooter';
  return 'Other';
}

function normalizeFuelType(value) {
  const text = String(value || '').trim().toLowerCase();
  const found = FUEL_VALUES.find(item => item.toLowerCase() === text);
  return found || 'Petrol';
}

function normalizePriceUnit(value) {
  const text = String(value || '').trim().toLowerCase();
  return PRICE_UNITS.includes(text) ? text : 'hour';
}

function normalizePlate(value) {
  return String(value || '').trim().replace(/[\s-]+/g, '').toUpperCase();
}

function calculateRentalQuote({ vehicle = {}, startDate, endDate, estimatedKm = 0 }) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw Object.assign(new Error('Valid start and end times are required.'), { statusCode: 400 });
  }

  const km = numberOr(estimatedKm, 0);
  if (km < 0 || km > 100000) {
    throw Object.assign(new Error('Estimated distance must be between 0 and 100,000 km.'), { statusCode: 400 });
  }

<<<<<<< HEAD
  // A booking of "10:00 to 10:00 two days later" is 48 hours exactly, but the
  // client sends timestamps generated a few milliseconds apart, which pushed the
  // raw duration just over 48h. A strict Math.ceil then billed 3 days instead
  // of 2. Rounding away sub-minute drift keeps genuine partial hours billable.
  const DURATION_TOLERANCE_MS = 60 * 1000;
  const rawMs = end.getTime() - start.getTime();
  const hours = Math.max(1, Math.ceil((rawMs - DURATION_TOLERANCE_MS) / 3600000));
  const priceUnit = normalizePriceUnit(vehicle.priceUnit || 'hour');
  const price = Math.max(0, numberOr(vehicle.price, 0));
  // Billable units are derived from the same tolerant duration used for the
  // hour count, so an exact 48-hour rental bills 2 days rather than 3.
=======
  const hours = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 3600000));
  const priceUnit = normalizePriceUnit(vehicle.priceUnit || 'hour');
  const price = Math.max(0, numberOr(vehicle.price, 0));
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  let billableUnits;
  if (priceUnit === 'day') billableUnits = Math.max(1, Math.ceil(hours / 24));
  else if (priceUnit === 'km') billableUnits = Math.max(1, Math.ceil(km));
  else billableUnits = hours;

  const baseRentalAmount = roundMoney(price * billableUnits);
  const includedKm = priceUnit === 'km' ? 0 : Math.max(0, numberOr(vehicle.includedKm, 300));
  const extraKmRate = Math.max(0, numberOr(vehicle.extraKmRate, 10));
  const extraKm = priceUnit === 'km' ? 0 : Math.max(0, km - includedKm);
  const extraKilometerCharges = roundMoney(extraKm * extraKmRate);
  const additionalCharges = roundMoney(Math.max(0, numberOr(vehicle.additionalCharges, 0)));
<<<<<<< HEAD
  const discountPercent = clamp(numberOr(vehicle.discountPercent, 0), 0, 100);
  const taxPercent = clamp(numberOr(vehicle.taxPercent, 0), 0, 100);
  const subtotal = roundMoney(baseRentalAmount + extraKilometerCharges + additionalCharges);
  const discountAmount = roundMoney(subtotal * discountPercent / 100);
  const discountedSubtotal = roundMoney(Math.max(0, subtotal - discountAmount));
  const taxFees = roundMoney(discountedSubtotal * taxPercent / 100);
  const grandTotal = roundMoney(discountedSubtotal + taxFees);
=======
  const taxPercent = clamp(numberOr(vehicle.taxPercent, 0), 0, 100);
  const subtotal = roundMoney(baseRentalAmount + extraKilometerCharges + additionalCharges);
  const taxFees = roundMoney(subtotal * taxPercent / 100);
  const grandTotal = roundMoney(subtotal + taxFees);
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1

  return {
    price: roundMoney(price),
    priceUnit,
    currency: 'INR',
    durationHours: hours,
    durationLabel: hours >= 24 ? `${Math.floor(hours / 24)} day(s), ${hours % 24} hour(s)` : `${hours} hour(s)`,
    billableUnits,
    baseRentalAmount,
    includedKm,
    estimatedKm: roundMoney(km),
    extraKm,
    extraKmRate: roundMoney(extraKmRate),
    extraKilometerCharges,
    additionalCharges,
<<<<<<< HEAD
    discountPercent,
    discountAmount,
    discountedSubtotal,
=======
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
    taxPercent,
    taxFees,
    subtotal,
    grandTotal,
<<<<<<< HEAD
    formula: `${billableUnits} ${priceUnit}${billableUnits === 1 ? '' : 's'} × ₹${roundMoney(price)}${extraKm ? ` + ${extraKm} extra km × ₹${roundMoney(extraKmRate)}` : ''}${additionalCharges ? ' + configured additional charges' : ''}${discountPercent ? ` - ${discountPercent}% discount` : ''}${taxPercent ? ` + ${taxPercent}% tax/fees` : ''}`,
    pricingVersion: 'revex-pricing-v3'
=======
    formula: `${billableUnits} ${priceUnit}${billableUnits === 1 ? '' : 's'} × ₹${roundMoney(price)}${extraKm ? ` + ${extraKm} extra km × ₹${roundMoney(extraKmRate)}` : ''}${additionalCharges ? ' + configured additional charges' : ''}${taxPercent ? ` + ${taxPercent}% tax/fees` : ''}`,
    pricingVersion: 'revex-pricing-v2'
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  };
}

function getSuggestionConfig() {
  return {
    Bike: Math.max(1, numberOr(process.env.PRICING_BASE_BIKE, 80)),
    Scooter: Math.max(1, numberOr(process.env.PRICING_BASE_SCOOTER, 100)),
    Car: Math.max(1, numberOr(process.env.PRICING_BASE_CAR, 300)),
    Other: Math.max(1, numberOr(process.env.PRICING_BASE_OTHER, 150))
  };
}

function suggestRentalPrice({ kilometers = 0, category = 'Other', fuelType = 'Petrol' } = {}) {
  const km = clamp(numberOr(kilometers, 0), 0, 70000);
  const normalizedCategory = normalizeCategory(category);
  const base = getSuggestionConfig()[normalizedCategory];
  // Transparent condition/usage adjustment: newer vehicles receive a small premium,
  // 70,000 km receives a 25% discount from the base condition value.
  const conditionFactor = 1.15 - (km / 70000) * 0.40;
  const fuelFactor = ({ Petrol: 1, Diesel: 1.04, Electric: 1.08, CNG: 0.98, Hybrid: 1.10 })[normalizeFuelType(fuelType)] || 1;
  const raw = base * conditionFactor * fuelFactor;
  const suggestedPrice = Math.max(10, Math.round(raw / 10) * 10);
  return {
    suggestedPrice,
    priceUnit: 'hour',
    currency: 'INR',
    category: normalizedCategory,
    fuelType: normalizeFuelType(fuelType),
    formula: `₹${base}/hour base × ${conditionFactor.toFixed(2)} usage factor × ${fuelFactor.toFixed(2)} fuel factor, rounded to ₹10`,
    configuration: {
      basePricePerHour: base,
      conditionFactor: Number(conditionFactor.toFixed(2)),
      fuelFactor: Number(fuelFactor.toFixed(2)),
      maxKilometer: 70000
    }
  };
}

module.exports = {
  CATEGORY_VALUES,
  FUEL_VALUES,
  PRICE_UNITS,
  calculateRentalQuote,
  normalizeCategory,
  normalizeFuelType,
  normalizePriceUnit,
  normalizePlate,
  roundMoney,
  suggestRentalPrice
};

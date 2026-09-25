function clientRoundMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function clientNumber(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function clientPriceUnit(value) { return ['hour', 'day', 'km'].includes(String(value)) ? String(value) : 'hour'; }
function clientCategory(value) { const text = String(value || '').toLowerCase(); return ({ car: 'Car', cars: 'Car', bike: 'Bike', bikes: 'Bike', scooter: 'Scooter', scooters: 'Scooter', other: 'Other' })[text] || 'Other'; }
function clientFuel(value) { return ['Petrol', 'Diesel', 'Electric', 'CNG', 'Hybrid'].includes(String(value)) ? String(value) : 'Petrol'; }
function calculateClientQuote(vehicle, startDate, endDate, estimatedKm) {
  const start = new Date(startDate); const end = new Date(endDate); const km = clientNumber(estimatedKm, 0);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new Error('Choose valid future start and end times.');
  if (km < 0 || km > 100000) throw new Error('Estimated distance must be between 0 and 100,000 km.');
  const hours = Math.max(1, Math.ceil((end - start) / 3600000)); const unit = clientPriceUnit(vehicle.priceUnit); const price = Math.max(0, clientNumber(vehicle.price));
  const billableUnits = unit === 'day' ? Math.max(1, Math.ceil(hours / 24)) : unit === 'km' ? Math.max(1, Math.ceil(km)) : hours;
  const baseRentalAmount = clientRoundMoney(price * billableUnits); const includedKm = unit === 'km' ? 0 : Math.max(0, clientNumber(vehicle.includedKm, 300));
  const extraKm = unit === 'km' ? 0 : Math.max(0, km - includedKm); const extraKmRate = Math.max(0, clientNumber(vehicle.extraKmRate, 10));
  const extraKilometerCharges = clientRoundMoney(extraKm * extraKmRate); const additionalCharges = clientRoundMoney(Math.max(0, clientNumber(vehicle.additionalCharges)));
  const taxPercent = Math.max(0, Math.min(100, clientNumber(vehicle.taxPercent))); const subtotal = clientRoundMoney(baseRentalAmount + extraKilometerCharges + additionalCharges);
  const taxFees = clientRoundMoney(subtotal * taxPercent / 100); const grandTotal = clientRoundMoney(subtotal + taxFees);
  return { price: clientRoundMoney(price), priceUnit: unit, currency: 'INR', durationHours: hours, durationLabel: `${hours} hour(s)`, billableUnits, baseRentalAmount, includedKm, estimatedKm: clientRoundMoney(km), extraKm, extraKmRate: clientRoundMoney(extraKmRate), extraKilometerCharges, additionalCharges, taxPercent, taxFees, subtotal, grandTotal, paidAmount: 0, remainingAmount: grandTotal, pricingVersion: 'revex-pricing-v2' };
}
function quoteRows(quote) {
  if (!quote) return '';
  return `<div class="quote-row"><span>Rental Amount <small>${quote.billableUnits} ${escapeHtml(quote.priceUnit)}${quote.billableUnits === 1 ? '' : 's'} × ${formatMoney(quote.price)}</small></span><strong>${formatMoney(quote.baseRentalAmount)}</strong></div>
    <div class="quote-row"><span>Additional Charges</span><strong>${formatMoney(quote.additionalCharges)}</strong></div>
    <div class="quote-row"><span>Extra Kilometer Charges <small>${quote.extraKm || 0} km × ${formatMoney(quote.extraKmRate)}</small></span><strong>${formatMoney(quote.extraKilometerCharges)}</strong></div>
    <div class="quote-row"><span>Tax / Fees <small>${quote.taxPercent || 0}%</small></span><strong>${formatMoney(quote.taxFees)}</strong></div>
    <div class="quote-total"><span>Grand Total</span><strong>${formatMoney(quote.grandTotal)}</strong></div>
    <div class="quote-row muted"><span>Amount Already Paid</span><strong>${formatMoney(quote.paidAmount || 0)}</strong></div>
    <div class="quote-row muted"><span>Remaining Amount</span><strong>${formatMoney(quote.remainingAmount ?? quote.grandTotal)}</strong></div>`;
}

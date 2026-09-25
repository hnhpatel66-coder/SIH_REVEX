let currentVehicle = null;
let currentQuote = null;
let quoteRequest = 0;

function vehicleImageMarkup(vehicle, className = '') {
  const image = assetUrl(vehicle.image || vehicle.vehiclePicture || '');
  const fallback = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480"><rect width="100%" height="100%" fill="#172c47"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="28" fill="#cbd5e1">Vehicle Image Unavailable</text></svg>')}`;
  return `<div class="vehicle-image ${className}"><img src="${escapeHtml(image)}" alt="${escapeHtml(vehicle.name || 'Vehicle')}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"></div>`;
}
function vehicleCard(vehicle) {
  const category = vehicle.category || vehicle.type || 'Other'; const unit = vehicle.priceUnit || 'hour';
  return `<article class="vehicle-card">${vehicleImageMarkup(vehicle)}<div class="card-body"><div class="card-top"><div><div class="badge-row"><span class="badge badge-category">${escapeHtml(category.toUpperCase())}</span><span class="badge badge-fuel">${escapeHtml(vehicle.fuelType || 'Petrol').toUpperCase()}</span></div><h3 class="card-title">${escapeHtml(vehicle.name || 'Vehicle')}</h3><p class="card-meta">${escapeHtml([vehicle.brand, vehicle.model].filter(Boolean).join(' ') || vehicle.name)} · ${escapeHtml(vehicle.location || '-')}</p></div><span class="star-rating" title="Rating">★ ${Number(vehicle.rating || 5).toFixed(1)}</span></div><div class="vehicle-facts"><span>${escapeHtml(vehicle.transmission || 'Manual')}</span><span>${Number(vehicle.currentKm || 0).toLocaleString('en-IN')} km</span><span>${vehicle.availability === 'unavailable' ? 'Unavailable' : 'Available'}</span></div><p class="card-price">${formatMoney(vehicle.price)} <small>/ ${escapeHtml(unit)}</small>${vehicle.discountPercent ? `<small> · ${vehicle.discountPercent}% off</small>` : ''}</p><div class="card-actions"><a class="btn btn-outline" href="vehicle-details.html?id=${encodeURIComponent(vehicle.id)}">View details</a><a class="btn btn-primary" href="vehicle-details.html?id=${encodeURIComponent(vehicle.id)}">Book now</a></div></div></article>`;
}
async function renderVehicles(filters = {}) {
  const box = document.getElementById('vehicleResults'); if (!box) return;
  box.innerHTML = '<div class="empty">Loading vehicles…</div>';
  try {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== null && String(value).trim()) params.set(key, value.trim()); });
    const vehicles = await api(`/vehicles?${params.toString()}`);
    box.innerHTML = vehicles.length ? vehicles.map(vehicleCard).join('') : '<div class="empty">No approved vehicles match those filters.</div>';
  } catch (error) { box.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
function updateQuoteButton() {
  const button = document.querySelector('#rentalBooking button[type="submit"]'); const consent = document.getElementById('agreementConsent');
  if (button) button.disabled = !currentQuote || !consent?.checked;
}
function renderQuote(quote) {
  const box = document.getElementById('rentalBreakdown'); if (!box) return;
  if (!quote) { box.innerHTML = '<div class="empty">Choose valid future times to see the price breakdown.</div>'; updateQuoteButton(); return; }
  box.innerHTML = `<div class="quote-heading"><strong>Rental Amount</strong><span>${escapeHtml(quote.durationLabel || `${quote.durationHours} hour(s)`)}</span></div>${quoteRows(quote)}`;
  updateQuoteButton();
}
async function refreshQuote() {
  const form = document.getElementById('rentalBooking'); if (!form || !currentVehicle) return;
  const start = form.startDate?.value; const end = form.endDate?.value; const km = form.estimatedKm?.value || 0;
  if (!start || !form.startTime?.value || !end || !form.endTime?.value) { currentQuote = null; renderQuote(null); return; }
  const requestId = ++quoteRequest;
  const params = new URLSearchParams({ startDate: `${start}T${form.startTime.value}`, endDate: `${end}T${form.endTime.value}`, estimatedKm: km });
  try {
    const quote = await api(`/vehicles/${encodeURIComponent(currentVehicle.id)}/quote?${params.toString()}`);
    if (requestId !== quoteRequest) return;
    currentQuote = quote; renderQuote(quote);
  } catch (error) {
    try { const quote = calculateClientQuote(currentVehicle, `${start}T${form.startTime.value}`, `${end}T${form.endTime.value}`, km); if (requestId === quoteRequest) { currentQuote = quote; renderQuote(quote); } } catch { currentQuote = null; renderQuote(null); }
  }
}
function calculateRental() { refreshQuote(); }
function setSafeBookingDefaults() {
  const form = document.getElementById('rentalBooking'); if (!form) return;
  const start = new Date(); start.setMinutes(Math.ceil((start.getMinutes() + 1) / 15) * 15, 0, 0); if (start <= new Date()) start.setHours(start.getHours() + 1);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const date = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const time = value => `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  if (form.startDate) { form.startDate.value = date(start); form.startDate.min = date(start); form.startTime.value = time(start); }
  if (form.endDate) { form.endDate.value = date(end); form.endDate.value = date(end); form.endTime.value = time(end); }
  refreshQuote();
}
function openPaymentModal(booking) {
  const modal = document.getElementById('simplePaymentModal'); const amount = document.getElementById('simplePaymentAmount');
  if (amount) amount.textContent = formatMoney(booking.quote?.grandTotal ?? booking.grandTotal ?? booking.totalAmount);
  modal?.classList.add('show');
  const pay = document.getElementById('simplePayNow'); const cancel = document.getElementById('simplePayCancel');
  pay.onclick = async () => {
    pay.disabled = true; pay.textContent = 'Processing…';
    try {
      const result = await api(`/bookings/${encodeURIComponent(booking.id)}/payment-demo`, { method: 'POST' });
      modal.classList.remove('show'); showModal('Payment received', `Booking ${result.booking.id} is paid and waiting for owner approval. Agreement: ${result.agreement?.agreementId || 'prepared'}.`);
      const download = document.getElementById('downloadAgreementBtn'); if (download) { download.style.display = 'inline-flex'; download.onclick = () => downloadAgreement(booking.id); }
    } catch (error) { alert(error.message); } finally { pay.disabled = false; pay.textContent = 'Pay Now'; }
  };
  cancel.onclick = async () => { modal.classList.remove('show'); try { await api(`/bookings/${encodeURIComponent(booking.id)}/payment-failed`, { method: 'POST' }); } catch {} };
}
async function confirmRental(event) {
  event.preventDefault();
  if (!requireLogin()) return;
  const form = event.target; const consent = document.getElementById('agreementConsent');
  if (!consent?.checked) { alert('Please read and accept the Rental Agreement and Terms & Conditions.'); return; }
  if (!currentVehicle?.id || !currentQuote) { await refreshQuote(); }
  if (!currentQuote) { alert('Choose valid future booking times first.'); return; }
  const button = form.querySelector('button[type="submit"]'); if (button) { button.disabled = true; button.textContent = 'Preparing booking…'; }
  try {
    const booking = await api('/bookings', { method: 'POST', body: { vehicleId: currentVehicle.id, startDate: `${form.startDate.value}T${form.startTime.value}`, endDate: `${form.endDate.value}T${form.endTime.value}`, estimatedKm: Number(form.estimatedKm.value) || 0, panNumber: form.panNumber.value.trim(), drivingLicenseNumber: form.drivingLicenseNumber.value.trim(), agreementAccepted: true, termsVersion: 'revex-v3' } });
    currentQuote = booking.quote || booking.pricing || currentQuote; openPaymentModal(booking);
  } catch (error) { alert(error.message); } finally { if (button) { button.disabled = !currentQuote || !consent.checked; button.textContent = 'Review agreement & continue'; } }
}

document.addEventListener('DOMContentLoaded', async () => {
  const search = document.getElementById('rentalSearch');
  if (search) {
    await renderVehicles();
    search.addEventListener('submit', event => { event.preventDefault(); renderVehicles({ location: search.location.value, category: search.category?.value, fuelType: search.fuelType?.value, maxPrice: search.maxPrice.value }); });
  }
  const detail = document.getElementById('vehicleDetail');
  if (!detail) return;
  const id = new URLSearchParams(location.search).get('id');
  if (!id) { detail.innerHTML = '<div class="empty">Vehicle ID is missing.</div>'; return; }
  try {
    currentVehicle = await api(`/vehicles/${encodeURIComponent(id)}`);
    if (currentVehicle.status !== 'approved' || !currentVehicle.verified) throw new Error('This vehicle is not currently available for booking.');
    const image = currentVehicle.image || currentVehicle.vehiclePicture || '';
    detail.innerHTML = `${vehicleImageMarkup(currentVehicle, 'detail-image')}<div class="badge-row"><span class="badge badge-category">${escapeHtml((currentVehicle.category || currentVehicle.type || 'Other').toUpperCase())}</span><span class="badge badge-fuel">${escapeHtml(currentVehicle.fuelType || 'Petrol').toUpperCase()}</span><span class="pill">${currentVehicle.verified ? 'Approved' : 'Pending approval'}</span></div><h1 class="section-title">${escapeHtml(currentVehicle.name)}</h1><p class="detail-subtitle">${escapeHtml([currentVehicle.brand, currentVehicle.model].filter(Boolean).join(' ') || 'Verified vehicle')} · ${escapeHtml(currentVehicle.location || '-')}</p><div class="detail-facts"><div><b>Category</b>${escapeHtml(currentVehicle.category || currentVehicle.type || '-')}</div><div><b>Fuel</b>${escapeHtml(currentVehicle.fuelType || '-')}</div><div><b>Transmission</b>${escapeHtml(currentVehicle.transmission || 'Manual')}</div><div><b>Odometer</b>${Number(currentVehicle.currentKm || 0).toLocaleString('en-IN')} km</div><div><b>Rating</b><span class="star-rating">★ ${Number(currentVehicle.rating || 5).toFixed(1)}</span></div><div><b>Owner</b>${escapeHtml(currentVehicle.owner?.name || 'Vehicle owner')}</div></div><hr><h2 class="section-title small-title">Book with a transparent breakdown</h2><p>${escapeHtml(currentVehicle.description || 'Well maintained and verified for a smooth rental.')}</p>`;
    const priceInput = document.getElementById('hourlyPrice'); if (priceInput) priceInput.value = currentVehicle.price;
    const form = document.getElementById('rentalBooking'); if (form) { form.dataset.vehicleId = currentVehicle.id; form.addEventListener('input', refreshQuote); form.addEventListener('change', refreshQuote); document.getElementById('agreementConsent')?.addEventListener('change', updateQuoteButton); setSafeBookingDefaults(); }
  } catch (error) { detail.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; document.getElementById('rentalBooking')?.querySelectorAll('input,select,button').forEach(control => { control.disabled = true; }); }
});

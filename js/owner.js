/* ============================================================================
 * OWNER PORTAL  (js/owner.js)
 *
 * List a vehicle, review rental booking requests, see the ride offers you
 * published, and track vehicle-wise earnings.
 *
 * Wrapped in an IIFE so none of its helpers leak onto `window` and start
 * shadowing the shared helpers in js/main.js. Everything it needs from
 * main.js arrives through `window.REVEX`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const REVEX = global.REVEX;
  if (!REVEX) return;
  const {
    api, escapeHtml, formatMoney, formatDate, formatDateTime, getStoredUser,
    showModal, showToast, confirmAction, statusBadge, imageOrInitials
  } = REVEX;
let ownerVehicles = [];
let ownerSummary = null;
let suggestionTimer = null;

function inr(value) { return formatMoney(value); }

// Upload budget: these limits keep the base64-encoded request comfortably under
// the server's JSON body cap (12 MB). Base64 inflates binary data by ~33%.
const UPLOAD_LIMITS = { photoMb: 2, documentMb: 0.8, maxDocuments: 6, totalMb: 7 };

function fileToDataUrl(file, maxMb = UPLOAD_LIMITS.documentMb) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve('');
    if (file.size > maxMb * 1024 * 1024) return reject(new Error(`${file.name} must be smaller than ${maxMb} MB.`));
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`)); reader.readAsDataURL(file);
  });
}

// Fails fast with a precise message instead of an opaque server 413.
function assertUploadBudget(files) {
  const list = [...files].filter(Boolean);
  if (list.length > UPLOAD_LIMITS.maxDocuments) throw new Error(`You can upload up to ${UPLOAD_LIMITS.maxDocuments} documents at a time.`);
  const totalBytes = list.reduce((sum, file) => sum + (file?.size || 0), 0);
  if (totalBytes > UPLOAD_LIMITS.totalMb * 1024 * 1024) {
    throw new Error(`Combined upload size is too large. Please compress files so the total is under ${UPLOAD_LIMITS.totalMb} MB.`);
  }
}
function checkPlate(value) {
  const hint = document.getElementById('plateHint'); if (!hint) return;
  const normalized = String(value || '').replace(/[\s-]/g, '').toUpperCase();
  hint.textContent = normalized.length >= 5 ? `Plate key: ${normalized}. Duplicate registration is checked securely when you save.` : 'Enter a valid registration number.';
}
async function documentsFromInputs(inputs) {
  const documents = [];
  for (const item of inputs) {
    const file = item.input?.files?.[0]; if (!file) continue;
    const dataUrl = await fileToDataUrl(file, 1.5);
    documents.push({ type: item.type, label: item.label, fileName: file.name, mimeType: file.type, dataUrl, size: file.size });
  }
  return documents;
}
function updatePriceSuggestion() {
  clearTimeout(suggestionTimer); suggestionTimer = setTimeout(async () => {
    const form = document.getElementById('vehicleListing'); const box = document.getElementById('priceSuggestion'); if (!form || !box) return;
    const category = form.category.value; const km = form.currentKm.value;
    if (!category && !km) return;
    try {
      const query = new URLSearchParams({ kilometers: km || 0, category: category || 'Other', fuelType: form.fuelType.value || 'Petrol' });
      const suggestion = await api(`/vehicles/price-suggestion?${query}`);
      box.innerHTML = `<strong>Suggested Rental Price: ${formatMoney(suggestion.suggestedPrice)}/${escapeHtml(suggestion.priceUnit)}</strong><span>${escapeHtml(suggestion.formula)}</span><button class="btn btn-outline" id="acceptSuggestion" type="button">Accept suggestion</button>`;
      document.getElementById('acceptSuggestion').onclick = () => { form.price.value = suggestion.suggestedPrice; form.priceUnit.value = suggestion.priceUnit; };
    } catch { box.innerHTML = '<strong>Suggested Rental Price: ₹—/hour</strong><span>Enter valid details to calculate a suggestion.</span>'; }
  }, 250);
}
function approvalBadge(vehicle) {
  const status = vehicle.status || 'pending'; const label = vehicle.statusLabel || ({ pending: 'Pending Approval', approved: 'Approved', rejected: 'Rejected', removed: 'Removed (legacy)' })[status];
  const className = status === 'approved' ? 'badge-approved' : status === 'rejected' ? 'badge-rejected' : status === 'removed' ? 'badge-removed' : 'badge-pending';
  return `<span class="badge ${className}">${escapeHtml(label)}</span>`;
}
function vehicleOwnerCard(vehicle) {
  // The shared image helper falls back to the vehicle's initials, so a missing
  // or broken photo shows the owner's initials instead of a placeholder graphic.
  const image = imageOrInitials(vehicle.image || vehicle.vehiclePicture, vehicle.name, { className: '', alt: vehicle.name });
  // If the owner scheduled this vehicle for a later date, spell it out: renters
  // can only book it on or after that day, so it looks "missing" otherwise.
  const futureFrom = vehicle.availableFrom && new Date(vehicle.availableFrom) > new Date();
  const visibilityNote = futureFrom
    ? `<p class="notice">Not bookable by renters until ${escapeHtml(formatDate(vehicle.availableFrom))}. Edit the vehicle to make it available sooner.</p>`
    : '';
  return `<article class="vehicle-card owner-vehicle-card"><div class="vehicle-image">${image}</div><div class="card-body">${approvalBadge(vehicle)}<h3 class="card-title">${escapeHtml(vehicle.name)}</h3><p class="card-meta">${escapeHtml(vehicle.category || vehicle.type || 'Other')} · ${escapeHtml(vehicle.fuelType || 'Petrol')} · ${escapeHtml(vehicle.location || '-')}</p><p class="card-meta">Registration: <b>${escapeHtml(vehicle.numberPlate || '-')}</b> · ${Number(vehicle.currentKm || 0).toLocaleString('en-IN')} km</p><p class="card-price">${inr(vehicle.price)} <small>/ ${escapeHtml(vehicle.priceUnit || 'hour')}</small>${vehicle.discountPercent ? `<small> · ${vehicle.discountPercent}% off</small>` : ''}</p><p class="card-meta">${vehicle.documents?.length || 0} document(s) uploaded · ${Number(vehicle.rating || 5).toFixed(1)} ★</p>${visibilityNote}${vehicle.rejectionReason ? `<p class="status-error">Reason: ${escapeHtml(vehicle.rejectionReason)}</p>` : ''}${vehicle.removalReason ? `<p class="status-error">Removal: ${escapeHtml(vehicle.removalReason)}</p>` : ''}<div class="card-actions"><a class="btn btn-outline" href="vehicle-details.html?id=${encodeURIComponent(vehicle.id)}">View</a><button class="btn btn-outline" type="button" data-edit-vehicle="${escapeHtml(vehicle.id)}">Edit</button><button class="btn btn-danger" type="button" data-delete-vehicle="${escapeHtml(vehicle.id)}" data-vehicle-name="${escapeHtml(vehicle.name || '')}">Delete</button></div></div></article>`;
}
async function renderOwnerVehicles() {
  const list = document.getElementById('ownerVehicleList'); if (!list) return;
  if (!requireRole('owner', 'admin')) return;
  list.innerHTML = '<div class="empty">Loading your vehicles…</div>';
  try { ownerVehicles = await api('/vehicles/mine'); list.innerHTML = ownerVehicles.length ? ownerVehicles.map(vehicleOwnerCard).join('') : '<div class="empty">You have not listed any vehicles yet.</div>'; }
  catch (error) { list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
async function renderOwnerDashboard() {
  const box = document.getElementById('ownerStats'); if (!box || !requireRole('owner', 'admin')) return;
  try {
    ownerSummary = await api('/bookings/owner/summary');
    const stats = [['Total vehicles', ownerSummary.totalVehicles || 0, 'All registered listings'], ['Approved vehicles', ownerSummary.approvedVehicles || 0, 'Visible to renters'], ['Pending vehicles', ownerSummary.pendingVehicles || 0, 'Awaiting verification'], ['Total bookings', ownerSummary.totalBookings || 0, 'All rental requests'], ['Active bookings', ownerSummary.activeBookings || 0, 'Confirmed or awaiting owner'], ['Completed rentals', ownerSummary.completedRentals || 0, 'Finished trips'], ['Total earnings', inr(ownerSummary.totalEarnings), '90% owner share'], ['Pending requests', ownerSummary.bookingRequests?.length || 0, 'Need your decision']];
    box.innerHTML = stats.map(item => `<article class="stat-card"><span class="eyebrow">${item[0]}</span><strong>${item[1]}</strong><small>${item[2]}</small></article>`).join('');
    const recent = document.getElementById('ownerRecent');
    recent.innerHTML = ownerSummary.bookingRequests?.length ? ownerSummary.bookingRequests.slice(0, 5).map(item => `<div class="list-row"><div><strong>${escapeHtml(item.userId?.name || 'Renter')}</strong><small>${escapeHtml(item.vehicleId?.name || 'Vehicle')} · ${formatDateTime(item.startDate)}</small></div><span class="badge badge-pending">${escapeHtml(item.status)}</span></div>`).join('') : '<div class="empty">No pending booking requests.</div>';
    const revenue = document.getElementById('ownerRevenue'); revenue.innerHTML = ownerSummary.revenuePerVehicle?.length ? ownerSummary.revenuePerVehicle.map(item => `<div class="list-row"><strong>${escapeHtml(item.vehicleName)}</strong><span>${inr(item.earnings)}</span></div>`).join('') : '<div class="empty">No paid rental earnings yet.</div>';
    const earnings = document.getElementById('ownerEarnings'); earnings.innerHTML = `<div class="earnings-highlight"><div><span>Total earnings</span><strong>${inr(ownerSummary.totalEarnings)}</strong></div><div><span>Completed earnings</span><strong>${inr(ownerSummary.completedEarnings)}</strong></div><div><span>Pending payment value</span><strong>${inr(ownerSummary.pendingPayments)}</strong></div></div><p class="form-note">Earnings are calculated from paid, non-cancelled confirmed/completed bookings. The platform retains 10% and the owner receives 90%.</p>`;
  } catch (error) { box.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
async function renderOwnerRequests() {
  const box = document.getElementById('ownerRequests'); if (!box || !requireRole('owner', 'admin')) return;
  box.innerHTML = '<div class="empty">Loading booking requests…</div>';
  try {
    const requests = await api('/bookings/owner/requests'); const admin = getStoredUser()?.role === 'admin';
    box.innerHTML = requests.length ? requests.map(item => { const quote = item.quote || {}; const canDecide = item.status === 'pending_owner'; return `<article class="request-card"><div class="request-main"><div class="badge-row"><span class="badge badge-category">${escapeHtml(item.vehicleId?.category || item.vehicleId?.type || 'Vehicle')}</span><span class="badge ${item.status === 'confirmed' ? 'badge-approved' : item.status === 'rejected' ? 'badge-rejected' : 'badge-pending'}">${escapeHtml(item.status)}</span></div><h3>${escapeHtml(item.userId?.name || 'Renter')} · ${escapeHtml(item.vehicleId?.name || 'Vehicle')}</h3><p>${escapeHtml(item.userId?.email || '')} ${item.userId?.phone ? `· ${escapeHtml(item.userId.phone)}` : ''}</p><div class="request-facts"><span><b>Start</b>${formatDateTime(item.startDate)}</span><span><b>End</b>${formatDateTime(item.endDate)}</span><span><b>Rental Amount</b>${formatMoney(quote.baseRentalAmount || 0)}</span>${quote.extraKilometerCharges ? `<span><b>Extra KM</b>${formatMoney(quote.extraKilometerCharges)}</span>` : ''}${quote.additionalCharges ? `<span><b>Additional</b>${formatMoney(quote.additionalCharges)}</span>` : ''}${quote.discountAmount ? `<span><b>Discount (${quote.discountPercent || 0}%)</b>-${formatMoney(quote.discountAmount)}</span>` : ''}<span><b>Tax / Fees</b>${formatMoney(quote.taxFees || 0)}</span><span><b>Grand Total</b>${formatMoney(quote.grandTotal || item.totalAmount || 0)}</span><span><b>Payment</b>${escapeHtml(item.paymentStatus)}</span><span><b>Agreement</b>${item.agreement ? escapeHtml(item.agreement.agreementStatus || 'Prepared') : 'Preparing'}</span></div></div><div class="request-actions">${canDecide ? `<button class="btn btn-primary" type="button" data-decision="approve" data-booking="${item.id}">Approve</button><button class="btn btn-danger" type="button" data-decision="reject" data-booking="${item.id}">Reject</button>` : ''}<a class="btn btn-outline" href="agreement.html?bookingId=${encodeURIComponent(item.id)}">View agreement</a>${admin ? `<a class="btn btn-outline" href="bookings.html?bookingId=${encodeURIComponent(item.id)}">Booking details</a>` : ''}</div></article>`; }).join('') : '<div class="empty">No booking requests yet. New requests will appear here immediately.</div>';
  } catch (error) { box.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
async function refreshOwnerPortal() { await Promise.all([renderOwnerDashboard(), renderOwnerVehicles(), renderOwnerRequests(), renderOwnerRides()]); }
function openEditVehicle(id) {
  const vehicle = ownerVehicles.find(item => item.id === id); if (!vehicle) return;
  document.getElementById('editVehicleId').value = vehicle.id; document.getElementById('editName').value = vehicle.name || ''; document.getElementById('editCategory').value = vehicle.category || vehicle.type || 'Other'; document.getElementById('editFuel').value = vehicle.fuelType || 'Petrol'; document.getElementById('editKm').value = vehicle.currentKm || 0; document.getElementById('editLocation').value = vehicle.location || ''; document.getElementById('editPrice').value = vehicle.price || ''; document.getElementById('editDiscount').value = vehicle.discountPercent || 0; document.getElementById('editUnit').value = vehicle.priceUnit || 'hour'; document.getElementById('editTransmission').value = vehicle.transmission || 'Manual'; document.getElementById('editDescription').value = vehicle.description || ''; document.getElementById('editAvailable').value = vehicle.availableFrom ? new Date(vehicle.availableFrom).toISOString().slice(0, 10) : ''; document.getElementById('editPhoto').value = ''; document.getElementById('editDocuments').value = ''; document.getElementById('editFormMessage').textContent = ''; document.getElementById('editVehicleModal').classList.add('show');
}
async function submitVehicle(event) {
  event.preventDefault(); if (!requireRole('owner', 'admin')) return;
  const form = event.target; const submit = form.querySelector('button[type="submit"]'); const message = document.getElementById('vehicleFormMessage'); window.RevexButtonUI?.start(submit, 'Submitting…'); message.textContent = 'Saving vehicle…'; message.className = 'form-message';
  try {
    assertUploadBudget([form.ownershipPaper.files[0], form.insurance.files[0], form.puc.files[0]]);
    const documents = await documentsFromInputs([{ input: form.ownershipPaper, type: 'ownership', label: 'Ownership papers' }, { input: form.insurance, type: 'insurance', label: 'Insurance' }, { input: form.puc, type: 'puc', label: 'PUC certificate' }]);
    const image = await fileToDataUrl(form.vehiclePicture.files[0], UPLOAD_LIMITS.photoMb);
    const vehicle = await api('/vehicles', { method: 'POST', body: { name: form.name.value.trim(), category: form.category.value, brand: form.brand.value.trim(), model: form.model.value.trim(), location: form.location.value.trim(), fuelType: form.fuelType.value, transmission: form.transmission.value, currentKm: Number(form.currentKm.value), price: Number(form.price.value), priceUnit: form.priceUnit.value, includedKm: Number(form.includedKm.value), extraKmRate: Number(form.extraKmRate.value), additionalCharges: Number(form.additionalCharges.value), discountPercent: Number(form.discountPercent.value), taxPercent: Number(form.taxPercent.value), available: form.available.value, numberPlate: form.numberPlate.value.trim(), description: form.description.value.trim(), vehiclePicture: image, documents } });
    window.RevexButtonUI?.success(submit, 'Submitted', 1600);
    message.textContent = ''; form.reset(); document.getElementById('vehicleKm').value = 0; await refreshOwnerPortal(); showModal('Vehicle listed successfully', `${vehicle.name} was saved. Status: Pending Approval.`); document.getElementById('fleet')?.scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    window.RevexButtonUI?.error(submit, 'Try again');
    message.textContent = error.message; message.className = 'form-message form-message-error';
  }
}
async function submitEditVehicle(event) {
  event.preventDefault(); const id = document.getElementById('editVehicleId').value; const message = document.getElementById('editFormMessage'); const submit = event.target.querySelector('button[type="submit"]'); window.RevexButtonUI?.start(submit, 'Saving…'); message.textContent = 'Saving changes…'; message.className = 'form-message';
  try {
    const body = { name: document.getElementById('editName').value.trim(), category: document.getElementById('editCategory').value, fuelType: document.getElementById('editFuel').value, currentKm: Number(document.getElementById('editKm').value), location: document.getElementById('editLocation').value.trim(), price: Number(document.getElementById('editPrice').value), discountPercent: Number(document.getElementById('editDiscount').value), priceUnit: document.getElementById('editUnit').value, transmission: document.getElementById('editTransmission').value, description: document.getElementById('editDescription').value.trim(), availableFrom: document.getElementById('editAvailable').value };
    const photo = document.getElementById('editPhoto').files[0];
    const files = [...document.getElementById('editDocuments').files];
    assertUploadBudget([...files, photo].filter(Boolean));
    if (photo) body.vehiclePicture = await fileToDataUrl(photo, UPLOAD_LIMITS.photoMb);
    if (files.length) body.documents = await Promise.all(files.map(async file => ({ type: 'other', label: file.name, fileName: file.name, mimeType: file.type, dataUrl: await fileToDataUrl(file, UPLOAD_LIMITS.documentMb), size: file.size })));
    const result = await api(`/vehicles/${encodeURIComponent(id)}`, { method: 'PUT', body }); window.RevexButtonUI?.success(submit, 'Saved', 1600); document.getElementById('editVehicleModal').classList.remove('show'); await refreshOwnerPortal(); showModal('Vehicle updated', result.message || 'Your changes were submitted for approval.'); message.textContent = '';
  } catch (error) {
    window.RevexButtonUI?.error(submit, 'Try again');
    message.textContent = error.message; message.className = 'form-message form-message-error';
  }
}
async function decideBooking(button) {
  const decision = button.dataset.decision; const id = button.dataset.booking;
  const answer = await confirmAction({
    title: decision === 'approve' ? 'Approve this rental request?' : 'Decline this rental request?',
    message: decision === 'approve'
      ? 'The renter is notified and the booking becomes confirmed. The agreement is signed by you.'
      : 'The renter has already paid, so declining refunds them under the REVEX cancellation policy (the policy fee is kept only if the free-cancellation window has passed).',
    confirmLabel: decision === 'approve' ? 'Approve request' : 'Decline and refund',
    tone: decision === 'approve' ? 'primary' : 'danger',
    reasonLabel: decision === 'approve' ? 'Note (optional)' : 'Reason (the renter sees this)',
    reasonRequired: decision !== 'approve'
  });
  if (!answer) return;
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="rvx-spinner" aria-hidden="true"></span>';
  try {
    const result = await api(`/bookings/${encodeURIComponent(id)}/owner-decision`, { method: 'POST', body: { decision, reason: answer.reason } });
    await refreshOwnerPortal();
    showModal('Request updated', result.message);
    showToast(result.message, 'ok', 8000);
    if (result.refund?.gatewayError) showToast(`Automatic refund failed: ${result.refund.gatewayError}`, 'bad', 12000);
  } catch (error) {
    showToast(error.message, 'bad', 8000);
    button.disabled = false; button.innerHTML = original;
  }
}

/**
 * The owner's ride offers with their approval state, seat usage and earnings.
 * Rides live on their own screen (ride-requests.html) for the seat REQUESTS;
 * this is the summary of the offers themselves.
 */
async function renderOwnerRides() {
  const box = document.getElementById('ownerRides');
  if (!box || !requireRole('owner', 'admin')) return;
  box.innerHTML = '<div class="empty">Loading your ride offers…</div>';
  try {
    const [rides, requests] = await Promise.all([
      api('/rides/mine'),
      api('/rides/requests?status=all').catch(() => [])
    ]);
    const byRide = new Map();
    for (const request of requests) {
      const key = String(request.rideId?._id || request.rideId || '');
      if (!byRide.has(key)) byRide.set(key, []);
      byRide.get(key).push(request);
    }
    const revenue = requests
      .filter(item => item.paymentStatus === 'paid' && ['confirmed', 'completed'].includes(item.status))
      .reduce((sum, item) => sum + (Number(item.totalAmount) || 0) * 0.9, 0);

    if (!rides.length) {
      box.innerHTML = `<div class="rvx-empty"><h3>No ride offers yet</h3><p>Publish a route and an admin will review it before riders can see it.</p><a class="rvx-btn rvx-btn--primary" href="offer-ride.html">Offer a ride</a></div>`;
      return;
    }

    const buckets = {
      Pending: rides.filter(r => r.status === 'pending').length,
      Approved: rides.filter(r => ['approved', 'available'].includes(r.status)).length,
      Rejected: rides.filter(r => r.status === 'rejected').length,
      Cancelled: rides.filter(r => ['cancelled', 'removed'].includes(r.status)).length,
      Completed: rides.filter(r => r.status === 'completed').length,
      'In progress': rides.filter(r => r.status === 'active').length,
      Upcoming: rides.filter(r => ['pending', 'approved', 'available'].includes(r.status) && new Date(r.date) >= new Date()).length
    };
    box.innerHTML = `
      <div class="rvx-stats">
        ${Object.entries(buckets).map(([label, value]) => `<div class="rvx-stat"><span class="rvx-stat__label">${escapeHtml(label)}</span><span class="rvx-stat__value">${value}</span></div>`).join('')}
        <div class="rvx-stat rvx-stat--accent"><span class="rvx-stat__label">Ride earnings</span><span class="rvx-stat__value">${formatMoney(revenue)}</span><span class="rvx-stat__hint">90% of confirmed and completed seats</span></div>
        <div class="rvx-stat"><span class="rvx-stat__label">Seat requests</span><span class="rvx-stat__value">${requests.length}</span><span class="rvx-stat__hint"><a href="ride-requests.html">Review</a></span></div>
      </div>
      <div class="rvx-table-wrap"><table class="rvx-table"><thead><tr><th>Ride</th><th>Vehicle</th><th>Date &amp; time</th><th class="num">Price / seat</th><th class="num">Seats</th><th class="num">Requests</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${rides.map(ride => {
          const mine = byRide.get(String(ride.id)) || [];
          const pending = mine.filter(item => item.status === 'pending_owner').length;
          return `<tr>
            <td><b>${escapeHtml(ride.from)} → ${escapeHtml(ride.to)}</b><br><small>ID ${escapeHtml(String(ride.id).slice(-8))}</small></td>
            <td>${escapeHtml(ride.vehicle || '-')}<br><small>${escapeHtml(ride.numberPlate || '')}</small></td>
            <td>${escapeHtml(formatDate(ride.date))}<br><small>${escapeHtml(ride.time || '')}</small></td>
            <td class="num">${formatMoney(ride.price)}</td>
            <td class="num">${ride.seatsBooked || 0}/${ride.seats}</td>
            <td class="num">${mine.length}${pending ? `<br><small>${pending} awaiting you</small>` : ''}</td>
            <td>${statusBadge(ride.status)}</td>
            <td><div class="rvx-table__actions">
              ${pending ? `<a class="btn btn-primary btn-small" href="ride-requests.html">Review ${pending}</a>` : ''}
              <a class="btn btn-outline btn-small" href="ride-details.html?id=${encodeURIComponent(ride.id)}">View</a>
              ${['pending', 'approved', 'available'].includes(ride.status) ? `<button class="btn btn-danger btn-small" type="button" data-cancel-ride-offer="${escapeHtml(ride.id)}" data-ride-route="${escapeHtml(ride.from)} → ${escapeHtml(ride.to)}">Cancel offer</button>` : ''}
            </div></td>
          </tr>`;
        }).join('')}
      </tbody></table></div>`;
  } catch (error) {
    box.innerHTML = `<div class="rvx-empty"><h3>Ride offers could not be loaded</h3><p>${escapeHtml(error.message)}</p></div>`;
  }
}

/**
 * Withdrawing an offer. Blocked while seats are held, because a paid rider has
 * to be refunded by an admin rather than silently losing a seat.
 */
async function cancelRideOffer(button) {
  const answer = await confirmAction({
    title: `Cancel the ${button.dataset.rideRoute} offer?`,
    message: 'The offer disappears from Find a Ride. Unpaid seat holds are released. If riders have already paid, an admin must remove the ride so those seats can be refunded.',
    confirmLabel: 'Cancel offer', tone: 'danger',
    reasonLabel: 'Reason (riders see this)', reasonRequired: true
  });
  if (!answer) return;
  const original = button.innerHTML;
  button.disabled = true; button.innerHTML = '<span class="rvx-spinner" aria-hidden="true"></span>';
  try {
    const result = await api(`/rides/${encodeURIComponent(button.dataset.cancelRideOffer)}/cancel`, { method: 'POST', body: { reason: answer.reason } });
    showToast(result.message || 'Ride offer cancelled.', 'ok', 8000);
    await renderOwnerRides();
  } catch (error) {
    showToast(error.message, 'bad', 9000);
    button.disabled = false; button.innerHTML = original;
  }
}

async function removeVehicle(id, name) {
  const vehicle = ownerVehicles.find(v => v.id === id);
  const ok = await confirmDelete({
    title: 'Delete vehicle permanently',
    lead: `${name || vehicle?.name || 'This vehicle'} will be removed from MongoDB and will no longer appear anywhere in REVEX.`,
    impact: [
      'The vehicle and its uploaded documents are deleted',
      'Every booking, agreement, payment and review for this vehicle is deleted',
      'The number plate becomes available for registration again'
    ],
    warning: 'This cannot be undone. Any booking history for this vehicle is permanently lost.',
    confirmLabel: 'Delete vehicle',
    onConfirm: async reason => {
      const result = await api(`/vehicles/${encodeURIComponent(id)}`, { method: 'DELETE', body: { reason, confirm: true } });
      await refreshOwnerPortal();
      showModal('Vehicle deleted', result.message);
      return true;
    }
  });
  if (!ok) showModal('Deletion cancelled', 'No changes were made.');
}
document.addEventListener('DOMContentLoaded', () => {
  if (!requireRole('owner', 'admin')) return;
  const available = document.getElementById('vehicleAvailable'); if (available) available.min = new Date().toISOString().slice(0, 10);
  document.getElementById('vehicleListing')?.addEventListener('submit', submitVehicle); document.getElementById('editVehicleForm')?.addEventListener('submit', submitEditVehicle);
  document.getElementById('vehicleListing')?.querySelectorAll('[name="category"],[name="fuelType"],[name="currentKm"]').forEach(input => { input.addEventListener('input', updatePriceSuggestion); input.addEventListener('change', updatePriceSuggestion); });
  /*
   * The number-plate availability check used to be wired with
   * oninput="checkPlate(this.value)" in the markup. `checkPlate` lives inside
   * this IIFE and is never put on `window`, so every keystroke in the plate
   * field threw "ReferenceError: checkPlate is not defined" and the duplicate-
   * plate warning never appeared. It is bound here instead, where it resolves.
   */
  const plateInput = document.getElementById('vehiclePlate');
  if (plateInput) {
    plateInput.addEventListener('input', () => checkPlate(plateInput.value));
    plateInput.addEventListener('blur', () => checkPlate(plateInput.value));
  }
  document.getElementById('ownerVehicleList')?.addEventListener('click', event => { const edit = event.target.closest('[data-edit-vehicle]'); const remove = event.target.closest('[data-delete-vehicle]'); if (edit) openEditVehicle(edit.dataset.editVehicle); if (remove) removeVehicle(remove.dataset.deleteVehicle, remove.dataset.vehicleName); });
  document.getElementById('ownerRequests')?.addEventListener('click', event => { const decision = event.target.closest('[data-decision]'); if (decision) decideBooking(decision); });
  document.getElementById('ownerRides')?.addEventListener('click', event => { const cancel = event.target.closest('[data-cancel-ride-offer]'); if (cancel) cancelRideOffer(cancel); });
  document.getElementById('closeEditVehicle')?.addEventListener('click', () => document.getElementById('editVehicleModal').classList.remove('show'));
  document.getElementById('refreshOwner')?.addEventListener('click', refreshOwnerPortal); refreshOwnerPortal();
});

})(window);

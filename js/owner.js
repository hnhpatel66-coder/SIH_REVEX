let ownerVehicles = [];
let ownerSummary = null;
let suggestionTimer = null;

function inr(value) { return formatMoney(value); }
<<<<<<< HEAD

// Upload budget: these limits keep the base64-encoded request comfortably under
// the server's JSON body cap (12 MB). Base64 inflates binary data by ~33%.
const UPLOAD_LIMITS = { photoMb: 2, documentMb: 0.8, maxDocuments: 6, totalMb: 7 };

function fileToDataUrl(file, maxMb = UPLOAD_LIMITS.documentMb) {
=======
function fileToDataUrl(file, maxMb = 3) {
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  return new Promise((resolve, reject) => {
    if (!file) return resolve('');
    if (file.size > maxMb * 1024 * 1024) return reject(new Error(`${file.name} must be smaller than ${maxMb} MB.`));
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`)); reader.readAsDataURL(file);
  });
}
<<<<<<< HEAD

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
=======
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
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
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
<<<<<<< HEAD
  const status = vehicle.status || 'pending'; const label = vehicle.statusLabel || ({ pending: 'Pending Approval', approved: 'Approved', rejected: 'Rejected', removed: 'Removed (legacy)' })[status];
=======
  const status = vehicle.status || 'pending'; const label = vehicle.statusLabel || ({ pending: 'Pending Approval', approved: 'Approved', rejected: 'Rejected', removed: 'Removed / Deregistered' })[status];
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  const className = status === 'approved' ? 'badge-approved' : status === 'rejected' ? 'badge-rejected' : status === 'removed' ? 'badge-removed' : 'badge-pending';
  return `<span class="badge ${className}">${escapeHtml(label)}</span>`;
}
function vehicleOwnerCard(vehicle) {
  const fallback = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480"><rect width="100%" height="100%" fill="#172c47"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="28" fill="#cbd5e1">REVEX Vehicle</text></svg>')}`;
  const image = vehicle.image || vehicle.vehiclePicture || fallback;
<<<<<<< HEAD
  return `<article class="vehicle-card owner-vehicle-card"><div class="vehicle-image"><img src="${escapeHtml(image)}" alt="${escapeHtml(vehicle.name)}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"></div><div class="card-body">${approvalBadge(vehicle)}<h3 class="card-title">${escapeHtml(vehicle.name)}</h3><p class="card-meta">${escapeHtml(vehicle.category || vehicle.type || 'Other')} · ${escapeHtml(vehicle.fuelType || 'Petrol')} · ${escapeHtml(vehicle.location || '-')}</p><p class="card-meta">Registration: <b>${escapeHtml(vehicle.numberPlate || '-')}</b> · ${Number(vehicle.currentKm || 0).toLocaleString('en-IN')} km</p><p class="card-price">${inr(vehicle.price)} <small>/ ${escapeHtml(vehicle.priceUnit || 'hour')}</small>${vehicle.discountPercent ? `<small> · ${vehicle.discountPercent}% off</small>` : ''}</p><p class="card-meta">${vehicle.documents?.length || 0} document(s) uploaded · ${Number(vehicle.rating || 5).toFixed(1)} ★</p>${vehicle.rejectionReason ? `<p class="status-error">Reason: ${escapeHtml(vehicle.rejectionReason)}</p>` : ''}${vehicle.removalReason ? `<p class="status-error">Removal: ${escapeHtml(vehicle.removalReason)}</p>` : ''}<div class="card-actions"><a class="btn btn-outline" href="vehicle-details.html?id=${encodeURIComponent(vehicle.id)}">View</a><button class="btn btn-outline" type="button" data-edit-vehicle="${vehicle.id}">Edit</button><button class="btn btn-danger" type="button" data-delete-vehicle="${vehicle.id}" data-vehicle-name="${escapeHtml(vehicle.name || '')}">Delete</button></div></div></article>`;
=======
  return `<article class="vehicle-card owner-vehicle-card"><div class="vehicle-image"><img src="${escapeHtml(image)}" alt="${escapeHtml(vehicle.name)}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"></div><div class="card-body">${approvalBadge(vehicle)}<h3 class="card-title">${escapeHtml(vehicle.name)}</h3><p class="card-meta">${escapeHtml(vehicle.category || vehicle.type || 'Other')} · ${escapeHtml(vehicle.fuelType || 'Petrol')} · ${escapeHtml(vehicle.location || '-')}</p><p class="card-meta">Registration: <b>${escapeHtml(vehicle.numberPlate || '-')}</b> · ${Number(vehicle.currentKm || 0).toLocaleString('en-IN')} km</p><p class="card-price">${inr(vehicle.price)} <small>/ ${escapeHtml(vehicle.priceUnit || 'hour')}</small></p><p class="card-meta">${vehicle.documents?.length || 0} document(s) uploaded · ${Number(vehicle.rating || 5).toFixed(1)} ★</p>${vehicle.rejectionReason ? `<p class="status-error">Reason: ${escapeHtml(vehicle.rejectionReason)}</p>` : ''}${vehicle.removalReason ? `<p class="status-error">Removal: ${escapeHtml(vehicle.removalReason)}</p>` : ''}<div class="card-actions"><a class="btn btn-outline" href="vehicle-details.html?id=${encodeURIComponent(vehicle.id)}">View</a><button class="btn btn-outline" type="button" data-edit-vehicle="${vehicle.id}">Edit</button><button class="btn btn-danger" type="button" data-delete-vehicle="${vehicle.id}">Remove</button></div></div></article>`;
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
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
<<<<<<< HEAD
    box.innerHTML = requests.length ? requests.map(item => { const quote = item.quote || {}; const canDecide = item.status === 'pending_owner'; return `<article class="request-card"><div class="request-main"><div class="badge-row"><span class="badge badge-category">${escapeHtml(item.vehicleId?.category || item.vehicleId?.type || 'Vehicle')}</span><span class="badge ${item.status === 'confirmed' ? 'badge-approved' : item.status === 'rejected' ? 'badge-rejected' : 'badge-pending'}">${escapeHtml(item.status)}</span></div><h3>${escapeHtml(item.userId?.name || 'Renter')} · ${escapeHtml(item.vehicleId?.name || 'Vehicle')}</h3><p>${escapeHtml(item.userId?.email || '')} ${item.userId?.phone ? `· ${escapeHtml(item.userId.phone)}` : ''}</p><div class="request-facts"><span><b>Start</b>${formatDateTime(item.startDate)}</span><span><b>End</b>${formatDateTime(item.endDate)}</span><span><b>Rental Amount</b>${formatMoney(quote.baseRentalAmount || 0)}</span>${quote.extraKilometerCharges ? `<span><b>Extra KM</b>${formatMoney(quote.extraKilometerCharges)}</span>` : ''}${quote.additionalCharges ? `<span><b>Additional</b>${formatMoney(quote.additionalCharges)}</span>` : ''}${quote.discountAmount ? `<span><b>Discount (${quote.discountPercent || 0}%)</b>-${formatMoney(quote.discountAmount)}</span>` : ''}<span><b>Tax / Fees</b>${formatMoney(quote.taxFees || 0)}</span><span><b>Grand Total</b>${formatMoney(quote.grandTotal || item.totalAmount || 0)}</span><span><b>Payment</b>${escapeHtml(item.paymentStatus)}</span><span><b>Agreement</b>${item.agreement ? escapeHtml(item.agreement.agreementStatus || 'Prepared') : 'Preparing'}</span></div></div><div class="request-actions">${canDecide ? `<button class="btn btn-primary" type="button" data-decision="approve" data-booking="${item.id}">Approve</button><button class="btn btn-danger" type="button" data-decision="reject" data-booking="${item.id}">Reject</button>` : ''}<a class="btn btn-outline" href="agreement.html?bookingId=${encodeURIComponent(item.id)}">View agreement</a>${admin ? `<a class="btn btn-outline" href="bookings.html?bookingId=${encodeURIComponent(item.id)}">Booking details</a>` : ''}</div></article>`; }).join('') : '<div class="empty">No booking requests yet. New requests will appear here immediately.</div>';
=======
    box.innerHTML = requests.length ? requests.map(item => { const quote = item.quote || {}; const canDecide = item.status === 'pending_owner'; return `<article class="request-card"><div class="request-main"><div class="badge-row"><span class="badge badge-category">${escapeHtml(item.vehicleId?.category || item.vehicleId?.type || 'Vehicle')}</span><span class="badge ${item.status === 'confirmed' ? 'badge-approved' : item.status === 'rejected' ? 'badge-rejected' : 'badge-pending'}">${escapeHtml(item.status)}</span></div><h3>${escapeHtml(item.userId?.name || 'Renter')} · ${escapeHtml(item.vehicleId?.name || 'Vehicle')}</h3><p>${escapeHtml(item.userId?.email || '')} ${item.userId?.phone ? `· ${escapeHtml(item.userId.phone)}` : ''}</p><div class="request-facts"><span><b>Start</b>${formatDateTime(item.startDate)}</span><span><b>End</b>${formatDateTime(item.endDate)}</span><span><b>Rental Amount</b>${formatMoney(quote.baseRentalAmount || 0)}</span><span><b>Grand Total</b>${formatMoney(quote.grandTotal || item.totalAmount || 0)}</span><span><b>Payment</b>${escapeHtml(item.paymentStatus)}</span><span><b>Agreement</b>${item.agreement ? escapeHtml(item.agreement.agreementStatus || 'Prepared') : 'Preparing'}</span></div></div><div class="request-actions">${canDecide ? `<button class="btn btn-primary" type="button" data-decision="approve" data-booking="${item.id}">Approve</button><button class="btn btn-danger" type="button" data-decision="reject" data-booking="${item.id}">Reject</button>` : ''}<a class="btn btn-outline" href="agreement.html?bookingId=${encodeURIComponent(item.id)}">View agreement</a>${admin ? `<a class="btn btn-outline" href="bookings.html?bookingId=${encodeURIComponent(item.id)}">Booking details</a>` : ''}</div></article>`; }).join('') : '<div class="empty">No booking requests yet. New requests will appear here immediately.</div>';
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  } catch (error) { box.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
async function refreshOwnerPortal() { await Promise.all([renderOwnerDashboard(), renderOwnerVehicles(), renderOwnerRequests()]); }
function openEditVehicle(id) {
  const vehicle = ownerVehicles.find(item => item.id === id); if (!vehicle) return;
<<<<<<< HEAD
  document.getElementById('editVehicleId').value = vehicle.id; document.getElementById('editName').value = vehicle.name || ''; document.getElementById('editCategory').value = vehicle.category || vehicle.type || 'Other'; document.getElementById('editFuel').value = vehicle.fuelType || 'Petrol'; document.getElementById('editKm').value = vehicle.currentKm || 0; document.getElementById('editLocation').value = vehicle.location || ''; document.getElementById('editPrice').value = vehicle.price || ''; document.getElementById('editDiscount').value = vehicle.discountPercent || 0; document.getElementById('editUnit').value = vehicle.priceUnit || 'hour'; document.getElementById('editTransmission').value = vehicle.transmission || 'Manual'; document.getElementById('editDescription').value = vehicle.description || ''; document.getElementById('editAvailable').value = vehicle.availableFrom ? new Date(vehicle.availableFrom).toISOString().slice(0, 10) : ''; document.getElementById('editPhoto').value = ''; document.getElementById('editDocuments').value = ''; document.getElementById('editFormMessage').textContent = ''; document.getElementById('editVehicleModal').classList.add('show');
=======
  document.getElementById('editVehicleId').value = vehicle.id; document.getElementById('editName').value = vehicle.name || ''; document.getElementById('editCategory').value = vehicle.category || vehicle.type || 'Other'; document.getElementById('editFuel').value = vehicle.fuelType || 'Petrol'; document.getElementById('editKm').value = vehicle.currentKm || 0; document.getElementById('editLocation').value = vehicle.location || ''; document.getElementById('editPrice').value = vehicle.price || ''; document.getElementById('editUnit').value = vehicle.priceUnit || 'hour'; document.getElementById('editTransmission').value = vehicle.transmission || 'Manual'; document.getElementById('editDescription').value = vehicle.description || ''; document.getElementById('editAvailable').value = vehicle.availableFrom ? new Date(vehicle.availableFrom).toISOString().slice(0, 10) : ''; document.getElementById('editPhoto').value = ''; document.getElementById('editDocuments').value = ''; document.getElementById('editFormMessage').textContent = ''; document.getElementById('editVehicleModal').classList.add('show');
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
}
async function submitVehicle(event) {
  event.preventDefault(); if (!requireRole('owner', 'admin')) return;
  const form = event.target; const submit = form.querySelector('button[type="submit"]'); const message = document.getElementById('vehicleFormMessage'); submit.disabled = true; message.textContent = 'Saving vehicle…'; message.className = 'form-message';
  try {
<<<<<<< HEAD
    assertUploadBudget([form.ownershipPaper.files[0], form.insurance.files[0], form.puc.files[0]]);
    const documents = await documentsFromInputs([{ input: form.ownershipPaper, type: 'ownership', label: 'Ownership papers' }, { input: form.insurance, type: 'insurance', label: 'Insurance' }, { input: form.puc, type: 'puc', label: 'PUC certificate' }]);
    const image = await fileToDataUrl(form.vehiclePicture.files[0], UPLOAD_LIMITS.photoMb);
    const vehicle = await api('/vehicles', { method: 'POST', body: { name: form.name.value.trim(), category: form.category.value, brand: form.brand.value.trim(), model: form.model.value.trim(), location: form.location.value.trim(), fuelType: form.fuelType.value, transmission: form.transmission.value, currentKm: Number(form.currentKm.value), price: Number(form.price.value), priceUnit: form.priceUnit.value, includedKm: Number(form.includedKm.value), extraKmRate: Number(form.extraKmRate.value), additionalCharges: Number(form.additionalCharges.value), discountPercent: Number(form.discountPercent.value), taxPercent: Number(form.taxPercent.value), available: form.available.value, numberPlate: form.numberPlate.value.trim(), description: form.description.value.trim(), vehiclePicture: image, documents } });
=======
    const documents = await documentsFromInputs([{ input: form.ownershipPaper, type: 'ownership', label: 'Ownership papers' }, { input: form.insurance, type: 'insurance', label: 'Insurance' }, { input: form.puc, type: 'puc', label: 'PUC certificate' }]);
    const image = await fileToDataUrl(form.vehiclePicture.files[0], 3);
    const vehicle = await api('/vehicles', { method: 'POST', body: { name: form.name.value.trim(), category: form.category.value, brand: form.brand.value.trim(), model: form.model.value.trim(), location: form.location.value.trim(), fuelType: form.fuelType.value, transmission: form.transmission.value, currentKm: Number(form.currentKm.value), price: Number(form.price.value), priceUnit: form.priceUnit.value, includedKm: Number(form.includedKm.value), extraKmRate: Number(form.extraKmRate.value), additionalCharges: Number(form.additionalCharges.value), taxPercent: Number(form.taxPercent.value), available: form.available.value, numberPlate: form.numberPlate.value.trim(), description: form.description.value.trim(), vehiclePicture: image, documents } });
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
    message.textContent = ''; form.reset(); document.getElementById('vehicleKm').value = 0; await refreshOwnerPortal(); showModal('Vehicle listed successfully', `${vehicle.name} was saved. Status: Pending Approval.`); document.getElementById('fleet')?.scrollIntoView({ behavior: 'smooth' });
  } catch (error) { message.textContent = error.message; message.className = 'form-message form-message-error'; } finally { submit.disabled = false; }
}
async function submitEditVehicle(event) {
  event.preventDefault(); const id = document.getElementById('editVehicleId').value; const message = document.getElementById('editFormMessage'); const submit = event.target.querySelector('button[type="submit"]'); submit.disabled = true; message.textContent = 'Saving changes…'; message.className = 'form-message';
  try {
<<<<<<< HEAD
    const body = { name: document.getElementById('editName').value.trim(), category: document.getElementById('editCategory').value, fuelType: document.getElementById('editFuel').value, currentKm: Number(document.getElementById('editKm').value), location: document.getElementById('editLocation').value.trim(), price: Number(document.getElementById('editPrice').value), discountPercent: Number(document.getElementById('editDiscount').value), priceUnit: document.getElementById('editUnit').value, transmission: document.getElementById('editTransmission').value, description: document.getElementById('editDescription').value.trim(), availableFrom: document.getElementById('editAvailable').value };
    const photo = document.getElementById('editPhoto').files[0];
    const files = [...document.getElementById('editDocuments').files];
    assertUploadBudget([...files, photo].filter(Boolean));
    if (photo) body.vehiclePicture = await fileToDataUrl(photo, UPLOAD_LIMITS.photoMb);
    if (files.length) body.documents = await Promise.all(files.map(async file => ({ type: 'other', label: file.name, fileName: file.name, mimeType: file.type, dataUrl: await fileToDataUrl(file, UPLOAD_LIMITS.documentMb), size: file.size })));
=======
    const body = { name: document.getElementById('editName').value.trim(), category: document.getElementById('editCategory').value, fuelType: document.getElementById('editFuel').value, currentKm: Number(document.getElementById('editKm').value), location: document.getElementById('editLocation').value.trim(), price: Number(document.getElementById('editPrice').value), priceUnit: document.getElementById('editUnit').value, transmission: document.getElementById('editTransmission').value, description: document.getElementById('editDescription').value.trim(), availableFrom: document.getElementById('editAvailable').value };
    const photo = document.getElementById('editPhoto').files[0]; if (photo) body.vehiclePicture = await fileToDataUrl(photo, 3);
    const files = [...document.getElementById('editDocuments').files]; if (files.length) body.documents = await Promise.all(files.map(async file => ({ type: 'other', label: file.name, fileName: file.name, mimeType: file.type, dataUrl: await fileToDataUrl(file, 1.5), size: file.size })));
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
    const result = await api(`/vehicles/${encodeURIComponent(id)}`, { method: 'PUT', body }); document.getElementById('editVehicleModal').classList.remove('show'); await refreshOwnerPortal(); showModal('Vehicle updated', result.message || 'Your changes were submitted for approval.'); message.textContent = '';
  } catch (error) { message.textContent = error.message; message.className = 'form-message form-message-error'; } finally { submit.disabled = false; }
}
async function decideBooking(button) {
  const decision = button.dataset.decision; const id = button.dataset.booking; let reason = '';
  if (decision === 'reject') { reason = prompt('Enter a reason for rejecting this booking request:'); if (reason === null || !reason.trim()) return; }
  if (decision === 'approve' && !confirm('Approve this booking request?')) return;
  try { const result = await api(`/bookings/${encodeURIComponent(id)}/owner-decision`, { method: 'POST', body: { decision, reason } }); await refreshOwnerPortal(); showModal('Request updated', result.message); } catch (error) { alert(error.message); }
}
<<<<<<< HEAD
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
=======
async function removeVehicle(id) { const reason = prompt('Enter a removal reason (optional for your own vehicle):'); if (reason === null) return; try { const result = await api(`/vehicles/${encodeURIComponent(id)}`, { method: 'DELETE', body: { reason } }); await refreshOwnerPortal(); showModal('Vehicle removed', result.message); } catch (error) { alert(error.message); } }
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
document.addEventListener('DOMContentLoaded', () => {
  if (!requireRole('owner', 'admin')) return;
  const available = document.getElementById('vehicleAvailable'); if (available) available.min = new Date().toISOString().slice(0, 10);
  document.getElementById('vehicleListing')?.addEventListener('submit', submitVehicle); document.getElementById('editVehicleForm')?.addEventListener('submit', submitEditVehicle);
  document.getElementById('vehicleListing')?.querySelectorAll('[name="category"],[name="fuelType"],[name="currentKm"]').forEach(input => { input.addEventListener('input', updatePriceSuggestion); input.addEventListener('change', updatePriceSuggestion); });
<<<<<<< HEAD
  document.getElementById('ownerVehicleList')?.addEventListener('click', event => { const edit = event.target.closest('[data-edit-vehicle]'); const remove = event.target.closest('[data-delete-vehicle]'); if (edit) openEditVehicle(edit.dataset.editVehicle); if (remove) removeVehicle(remove.dataset.deleteVehicle, remove.dataset.vehicleName); });
=======
  document.getElementById('ownerVehicleList')?.addEventListener('click', event => { const edit = event.target.closest('[data-edit-vehicle]'); const remove = event.target.closest('[data-delete-vehicle]'); if (edit) openEditVehicle(edit.dataset.editVehicle); if (remove) removeVehicle(remove.dataset.deleteVehicle); });
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  document.getElementById('ownerRequests')?.addEventListener('click', event => { const decision = event.target.closest('[data-decision]'); if (decision) decideBooking(decision); });
  document.getElementById('closeEditVehicle')?.addEventListener('click', () => document.getElementById('editVehicleModal').classList.remove('show'));
  document.getElementById('refreshOwner')?.addEventListener('click', refreshOwnerPortal); refreshOwnerPortal();
});

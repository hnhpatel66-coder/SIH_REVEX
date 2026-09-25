const adminState = {
  summary: null, vehicles: [], owners: [], bookings: [], users: [], income: null, rides: [], profile: null,
  vehicleFilter: 'all', activeTab: 'dashboard', activeOwnerId: null
};

function adminMessage(message, error = false) {
  const box = document.getElementById('adminMessage');
  if (!box) return;
  box.textContent = message;
  box.className = `form-message${error ? ' form-message-error' : ''}`;
  if (message) setTimeout(() => { if (box.textContent === message) box.textContent = ''; }, 5000);
}
function statCard(label, value, note) {
  return `<article class="stat-card"><span class="eyebrow">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
}
function documentLinks(vehicle) {
  const documents = vehicle.documents || [];
  if (!documents.length) return '<span class="muted-text">No documents uploaded</span>';
  return `<div class="document-list">${documents.map(document => {
    const dataUrl = document.dataUrl || '';
    const isImage = String(document.mimeType || dataUrl).startsWith('image/') || dataUrl.startsWith('data:image/');
    const preview = dataUrl && isImage ? `<img class="document-thumb" src="${escapeHtml(dataUrl)}" alt="${escapeHtml(document.label || document.type)}">` : '';
    const links = dataUrl ? `<a href="${escapeHtml(dataUrl)}" target="_blank" rel="noopener">Open</a> <a href="${escapeHtml(dataUrl)}" download="${escapeHtml(document.fileName || `${document.type}.bin`)}">Download</a>` : `<span>${escapeHtml(document.fileName || 'File name only')}</span>`;
    return `<div class="document-item">${preview}<div><b>${escapeHtml(document.label || document.type)}</b><small>${escapeHtml(document.fileName || 'Uploaded file')} · ${escapeHtml(document.status || 'pending')}</small><br>${links}</div></div>`;
  }).join('')}</div>`;
}
function vehicleRow(vehicle) {
  const status = vehicle.status || 'pending';
  const canReview = ['pending', 'rejected'].includes(status);
  const badgeClass = status === 'approved' ? 'badge-approved' : status === 'rejected' ? 'badge-rejected' : status === 'removed' ? 'badge-removed' : 'badge-pending';
  return `<article class="moderation-card"><div class="moderation-main"><div class="badge-row"><span class="badge ${badgeClass}">${escapeHtml(vehicle.statusLabel || status)}</span><span class="badge badge-category">${escapeHtml(vehicle.category || vehicle.type || 'Other')}</span><span class="badge badge-fuel">${escapeHtml(vehicle.fuelType || 'Petrol')}</span></div><h3>${escapeHtml(vehicle.name)}</h3><p class="card-meta">${escapeHtml(vehicle.brand || '')} ${escapeHtml(vehicle.model || '')} · ${escapeHtml(vehicle.location || '-')} · ${Number(vehicle.currentKm || 0).toLocaleString('en-IN')} km · ${formatMoney(vehicle.price)}/${escapeHtml(vehicle.priceUnit || 'hour')}</p><p class="card-meta">Plate: <b>${escapeHtml(vehicle.numberPlate || '-')}</b> · Owner: ${escapeHtml(vehicle.owner?.name || 'Unknown')} ${vehicle.owner?.email ? `(${escapeHtml(vehicle.owner.email)})` : ''}</p>${vehicle.rejectionReason ? `<p class="status-error">Rejection reason: ${escapeHtml(vehicle.rejectionReason)}</p>` : ''}${vehicle.removalReason ? `<p class="status-error">Removal reason: ${escapeHtml(vehicle.removalReason)}</p>` : ''}<div class="document-section"><h4>Uploaded documents</h4>${documentLinks(vehicle)}</div></div><div class="moderation-actions">${canReview ? `<button class="btn btn-primary" type="button" data-verify="${vehicle.id}" data-decision="approve">Approve</button><button class="btn btn-danger" type="button" data-verify="${vehicle.id}" data-decision="reject">Reject</button>` : ''}${status !== 'removed' ? `<button class="btn btn-outline" type="button" data-remove-vehicle="${vehicle.id}">Deregister</button>` : ''}</div></article>`;
}
function renderStats() {
  const summary = adminState.summary;
  if (!summary) return;
  document.getElementById('adminStats').innerHTML = [
    statCard('Total users', summary.users, 'Active accounts'), statCard('Total owners', summary.owners, 'Owner accounts'), statCard('Total vehicles', summary.vehicles, 'All registrations'),
    statCard('Pending approval', summary.pendingVehicleVerification, 'Awaiting documents'), statCard('Approved vehicles', summary.approvedVehicles, 'Live listings'), statCard('Rejected vehicles', summary.rejectedVehicles, 'Needs correction'),
    statCard('Total bookings', summary.bookings, 'Rental records'), statCard('Total revenue', formatMoney(summary.totalRevenue), 'Paid bookings')
  ].join('');
}
function renderApprovalSummary() {
  const box = document.getElementById('adminApprovalSummary');
  if (!box) return;
  const pending = adminState.vehicles.filter(vehicle => vehicle.status === 'pending');
  const pendingRides = adminState.rides.filter(ride => !ride.verified && ride.status !== 'removed');
  const vehicleMarkup = pending.length ? pending.slice(0, 4).map(vehicle => `<div class="list-row"><div><strong>${escapeHtml(vehicle.name)}</strong><small>${escapeHtml(vehicle.owner?.name || 'Owner')} · ${escapeHtml(vehicle.numberPlate || 'No plate')}</small></div><button class="btn btn-primary btn-small" data-verify="${vehicle.id}" data-decision="approve">Approve</button></div>`).join('') : '<div class="empty">No vehicles are waiting for approval.</div>';
  const rideMarkup = pendingRides.length ? `<h4 style="margin-top:18px">Ride offers</h4>${pendingRides.slice(0, 3).map(ride => `<div class="list-row"><div><strong>${escapeHtml(ride.from)} → ${escapeHtml(ride.to)}</strong><small>${escapeHtml(ride.driver || 'Owner')}</small></div><button class="btn btn-primary btn-small" data-ride-verify="${ride.id}" data-ride-id="${ride.id}" data-decision="approve">Approve</button><button class="btn btn-danger btn-small" data-ride-verify="${ride.id}" data-ride-id="${ride.id}" data-decision="reject">Reject</button></div>`).join('')}` : '';
  box.innerHTML = vehicleMarkup + rideMarkup;
}
function renderActivity() {
  const box = document.getElementById('adminActivity');
  if (!box) return;
  const recent = adminState.bookings.slice(0, 5);
  box.innerHTML = recent.length ? recent.map(item => `<div class="list-row"><div><strong>${escapeHtml(item.vehicleId?.name || 'Vehicle')}</strong><small>${escapeHtml(item.userId?.name || 'User')} · ${formatDateTime(item.createdAt)}</small></div><span class="badge badge-muted">${escapeHtml(item.status)}</span></div>`).join('') : '<div class="empty">No booking activity yet.</div>';
}
function renderVehicles() {
  const box = document.getElementById('adminVehicles');
  if (!box) return;
  const list = adminState.vehicleFilter === 'all' ? adminState.vehicles : adminState.vehicles.filter(vehicle => vehicle.status === adminState.vehicleFilter);
  box.innerHTML = list.length ? list.map(vehicleRow).join('') : '<div class="empty">No vehicles in this status.</div>';
}
function renderOwners() {
  const box = document.getElementById('adminOwners');
  if (!box) return;
  box.innerHTML = adminState.owners.length ? adminState.owners.map(owner => `<article class="owner-summary-row"><div><h3>${escapeHtml(owner.name)}</h3><p>${escapeHtml(owner.email)} ${owner.phone ? `· ${escapeHtml(owner.phone)}` : ''}</p><div class="owner-metrics"><span><b>${owner.totalVehicles}</b> vehicles</span><span><b>${owner.totalBookings}</b> bookings</span><span><b>${formatMoney(owner.totalEarnings)}</b> earnings</span><span><b>${owner.pendingVehicles}</b> pending</span></div></div><button class="btn btn-outline" type="button" data-owner-details="${owner.id}">View owner</button></article>`).join('') : '<div class="empty">No owner accounts found.</div>';
}
function renderOwnerDetail(data) {
  const box = document.getElementById('adminOwnerDetail');
  if (!box) return;
  if (!data) { box.innerHTML = ''; return; }
  const totals = data.totals || {};
  box.innerHTML = `<article class="detail-panel owner-detail-panel"><div class="panel-heading"><div><span class="eyebrow">OWNER DETAILS</span><h2>${escapeHtml(data.owner.name)}</h2><p>${escapeHtml(data.owner.email)} ${data.owner.phone ? `· ${escapeHtml(data.owner.phone)}` : ''}</p></div><button class="btn btn-outline" id="closeOwnerDetail" type="button">Close</button></div><div class="owner-metrics"><span><b>${totals.totalVehicles || 0}</b> total vehicles</span><span><b>${totals.approvedVehicles || 0}</b> approved</span><span><b>${totals.pendingVehicles || 0}</b> pending</span><span><b>${totals.rejectedVehicles || 0}</b> rejected</span><span><b>${totals.totalBookings || 0}</b> bookings</span><span><b>${formatMoney(totals.totalEarnings || 0)}</b> earnings</span></div><h3>Vehicles and vehicle-wise income</h3><div class="admin-vehicle-detail-list">${(data.vehicles || []).map(vehicle => `<div class="admin-vehicle-detail"><div><strong>${escapeHtml(vehicle.name)}</strong><small>${escapeHtml(vehicle.numberPlate || '-')} · ${escapeHtml(vehicle.statusLabel || vehicle.status)}</small><small>${vehicle.totalBookings || 0} booking(s) · ${formatMoney(vehicle.totalEarnings || 0)} owner income</small></div>${vehicle.status !== 'removed' ? `<button class="btn btn-danger btn-small" type="button" data-owner-remove-vehicle="${vehicle.id}" data-owner-name="${escapeHtml(data.owner.name)}">Deregister</button>` : ''}</div>`).join('')}</div><h3 style="margin-top:24px">Recent bookings</h3>${(data.recentBookings || []).slice(0, 8).map(booking => `<div class="list-row"><div><strong>${escapeHtml(booking.vehicleId?.name || 'Vehicle')}</strong><small>${escapeHtml(booking.userId?.name || 'User')} · ${formatDateTime(booking.startDate)}</small></div><span class="badge badge-muted">${escapeHtml(booking.status)}</span></div>`).join('') || '<div class="empty">No bookings for this owner.</div>'}</article>`;
  box.querySelector('#closeOwnerDetail')?.addEventListener('click', () => { adminState.activeOwnerId = null; renderOwnerDetail(null); });
}
function renderBookings() {
  const box = document.getElementById('adminBookings');
  if (!box) return;
  box.innerHTML = adminState.bookings.length ? adminState.bookings.map(booking => `<article class="booking-row"><div><div class="badge-row"><span class="badge badge-muted">${escapeHtml(booking.status)}</span><span class="badge ${booking.paymentStatus === 'paid' ? 'badge-approved' : 'badge-pending'}">${escapeHtml(booking.paymentStatus)}</span></div><h3>${escapeHtml(booking.vehicleId?.name || 'Vehicle')}</h3><p class="card-meta">${escapeHtml(booking.userId?.name || 'User')} · ${formatDateTime(booking.startDate)} · Grand Total ${formatMoney(booking.grandTotal || booking.totalAmount || 0)}</p></div><div class="request-actions">${booking.status === 'pending_owner' && booking.paymentStatus === 'paid' ? `<button class="btn btn-outline btn-small" data-booking-status="confirmed" data-booking-id="${booking.id}" type="button">Confirm</button>` : ''}${!['completed', 'cancelled', 'rejected'].includes(booking.status) && booking.paymentStatus !== 'paid' ? `<button class="btn btn-danger btn-small" data-booking-status="cancelled" data-booking-id="${booking.id}" type="button">Cancel</button>` : ''}<a class="btn btn-outline btn-small" href="agreement.html?bookingId=${encodeURIComponent(booking.id)}">Agreement</a></div></article>`).join('') : '<div class="empty">No bookings found.</div>';
}
function renderIncome() {
  const income = adminState.income;
  if (!income) return;
  document.getElementById('incomeCards').innerHTML = [statCard('Total revenue', formatMoney(income.totalRevenue), 'Paid rental + rides'), statCard('Platform share', formatMoney(income.commission), '10% service share'), statCard('Owner payout', formatMoney(income.ownerPayout), '90% owner share'), statCard('Completed bookings', income.completedBookings, 'Completed rentals'), statCard('Pending bookings', income.pendingBookings, 'Payment or owner review'), statCard('Cancelled bookings', income.cancelledBookings, 'Excluded from revenue')].join('');
  document.getElementById('incomeByVehicle').innerHTML = income.revenueByVehicle?.length ? income.revenueByVehicle.map(item => `<div class="list-row"><div><strong>${escapeHtml(item.vehicleName)}</strong><small>${escapeHtml(item.ownerName)} · ${item.bookings} booking(s)</small></div><strong>${formatMoney(item.revenue)}</strong></div>`).join('') : '<div class="empty">No paid vehicle revenue yet.</div>';
  document.getElementById('incomeByOwner').innerHTML = income.revenueByOwner?.length ? income.revenueByOwner.map(item => `<div class="list-row"><div><strong>${escapeHtml(item.ownerName)}</strong><small>${item.bookings} booking(s)</small></div><strong>${formatMoney(item.revenue)}</strong></div>`).join('') : '<div class="empty">No owner revenue yet.</div>';
  document.getElementById('incomeRecent').innerHTML = income.recent?.length ? income.recent.map(item => `<div class="list-row"><div><strong>${escapeHtml(item.vehicle)}</strong><small>${escapeHtml(item.renter)} · ${formatDateTime(item.date)}</small></div><strong>${formatMoney(item.amount)}</strong></div>`).join('') : '<div class="empty">No transactions yet.</div>';
}
function renderUsers() {
  const box = document.getElementById('adminUsers');
  if (!box) return;
  const me = getStoredUser();
  const groups = [['Admins', 'admin'], ['Owners', 'owner'], ['Users', 'user']];
  box.innerHTML = groups.map(([label, role]) => {
    const users = adminState.users.filter(user => user.role === role);
    return `<h3>${label} (${users.length})</h3>${users.map(user => `<div class="user-admin-row"><div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)} · ${escapeHtml(user.phone || 'No phone')} · ${user.active === false ? 'Deactivated' : 'Active'}</small></div>${user.id !== me?.id && user.active !== false ? `<button class="btn btn-danger btn-small" data-deactivate-user="${user.id}" data-user-name="${escapeHtml(user.name)}" type="button">Deactivate</button>` : ''}</div>`).join('') || '<div class="empty">No accounts.</div>'}`;
  }).join('');
}
function renderAdminProfile() {
  const box = document.getElementById('adminProfile');
  if (!box || !adminState.profile) return;
  const user = adminState.profile;
  box.innerHTML = `<p><b>Name:</b> ${escapeHtml(user.name)}</p><p><b>Email:</b> ${escapeHtml(user.email)}</p><p><b>Phone:</b> ${escapeHtml(user.phone || '-')}</p><p><b>Role:</b> Admin</p><a class="btn btn-outline" href="profile.html">Edit profile</a>`;
}
async function loadData() {
  const requests = [api('/admin/summary'), api('/admin/vehicles?status=all'), api('/admin/owners'), api('/admin/bookings'), api('/admin/income'), api('/admin/users'), api('/rides?status=all'), api('/auth/me')];
  const results = await Promise.allSettled(requests);
  const values = results.map(result => result.status === 'fulfilled' ? result.value : null);
  const safeArray = value => Array.isArray(value) ? value : [];
  adminState.summary = values[0] || null;
  adminState.vehicles = safeArray(values[1]);
  adminState.owners = safeArray(values[2]);
  adminState.bookings = safeArray(values[3]);
  adminState.income = values[4] || null;
  adminState.users = safeArray(values[5]);
  adminState.rides = safeArray(values[6]);
  adminState.profile = values[7]?.user || null;
  renderStats(); renderApprovalSummary(); renderActivity(); renderVehicles(); renderOwners(); renderBookings(); renderIncome(); renderUsers(); renderAdminProfile();
  const failed = results.find(result => result.status === 'rejected');
  if (failed) adminMessage(failed.reason?.message || 'Some admin data could not be loaded.', true);
}
function showTab(tab) {
  adminState.activeTab = tab;
  document.querySelectorAll('.admin-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.admin-panel').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${tab}`));
  try { sessionStorage.setItem('revexAdminTab', tab); } catch {}
}
async function moderateVehicle(button) {
  const decision = button.dataset.decision; let reason = '';
  if (decision === 'reject') { reason = prompt('Enter a rejection reason for the owner:'); if (reason === null || !reason.trim()) return; }
  if (decision === 'approve' && !confirm('Approve this vehicle and make it bookable?')) return;
  try { const result = await api(`/admin/vehicles/${encodeURIComponent(button.dataset.verify)}/verify`, { method: 'PATCH', body: { decision, reason } }); adminMessage(result.message); await loadData(); } catch (error) { adminMessage(error.message, true); }
}
async function removeVehicle(button) {
  const reason = prompt('Enter a deregistration reason. Historical bookings will be preserved:'); if (reason === null || !reason.trim()) return;
  try { const result = await api(`/admin/vehicles/${encodeURIComponent(button.dataset.removeVehicle)}`, { method: 'DELETE', body: { reason } }); adminMessage(result.message); await loadData(); } catch (error) { adminMessage(error.message, true); }
}
async function loadOwnerDetail(id) {
  try { const data = await api(`/admin/owners/${encodeURIComponent(id)}`); adminState.activeOwnerId = id; renderOwnerDetail(data); document.getElementById('adminOwnerDetail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (error) { adminMessage(error.message, true); }
}
async function ownerDeregister(button) {
  const reason = prompt(`Enter a reason to deregister this vehicle for ${button.dataset.ownerName}:`); if (reason === null || !reason.trim()) return;
  try { const result = await api(`/admin/vehicles/${encodeURIComponent(button.dataset.ownerRemoveVehicle)}`, { method: 'DELETE', body: { reason } }); adminMessage(result.message); await loadData(); if (adminState.activeOwnerId) await loadOwnerDetail(adminState.activeOwnerId); } catch (error) { adminMessage(error.message, true); }
}
async function updateBooking(button) {
  if (!confirm(`Set this booking to ${button.dataset.bookingStatus}?`)) return;
  try { const result = await api(`/admin/bookings/${encodeURIComponent(button.dataset.bookingId)}/status`, { method: 'PATCH', body: { status: button.dataset.bookingStatus } }); adminMessage(`Booking updated: ${result.status}`); await loadData(); } catch (error) { adminMessage(error.message, true); }
}
async function deactivateUser(button) {
  if (!confirm(`Deactivate ${button.dataset.userName}? Historical records will be preserved.`)) return;
  try { const result = await api(`/admin/users/${encodeURIComponent(button.dataset.deactivateUser)}`, { method: 'DELETE' }); adminMessage(result.message); await loadData(); } catch (error) { adminMessage(error.message, true); }
}
async function verifyRide(button) {
  const decision = button.dataset.decision || 'approve'; let reason = '';
  if (decision === 'reject') { reason = prompt('Enter a ride rejection reason:'); if (reason === null || !reason.trim()) return; }
  try { await api(`/admin/rides/${encodeURIComponent(button.dataset.rideId || button.dataset.rideVerify)}/verify`, { method: 'PATCH', body: { decision, reason } }); adminMessage(decision === 'approve' ? 'Ride approved.' : 'Ride rejected.'); await loadData(); } catch (error) { adminMessage(error.message, true); }
}
document.addEventListener('DOMContentLoaded', async () => {
  if (getStoredUser()?.role !== 'admin') return;
  document.querySelector('[data-exit-admin]')?.addEventListener('click', () => { clearSession(); location.href = 'index.html'; });
  document.querySelector('.admin-tabs')?.addEventListener('click', event => { const button = event.target.closest('[data-tab]'); if (button) showTab(button.dataset.tab); });
  document.body.addEventListener('click', async event => {
    const go = event.target.closest('[data-go-tab]'); if (go) { if (go.dataset.statusFilter) { adminState.vehicleFilter = go.dataset.statusFilter; document.querySelectorAll('[data-vehicle-filter]').forEach(chip => chip.classList.toggle('active', chip.dataset.vehicleFilter === adminState.vehicleFilter)); renderVehicles(); } showTab(go.dataset.goTab); return; }
    const refresh = event.target.closest('[data-refresh]'); if (refresh) { await loadData(); return; }
    const filter = event.target.closest('[data-vehicle-filter]'); if (filter) { adminState.vehicleFilter = filter.dataset.vehicleFilter; document.querySelectorAll('[data-vehicle-filter]').forEach(chip => chip.classList.toggle('active', chip === filter)); renderVehicles(); return; }
    const verify = event.target.closest('[data-verify]'); if (verify) return moderateVehicle(verify);
    const remove = event.target.closest('[data-remove-vehicle]'); if (remove) return removeVehicle(remove);
    const owner = event.target.closest('[data-owner-details]'); if (owner) return loadOwnerDetail(owner.dataset.ownerDetails);
    const ownerRemove = event.target.closest('[data-owner-remove-vehicle]'); if (ownerRemove) return ownerDeregister(ownerRemove);
    const booking = event.target.closest('[data-booking-status]'); if (booking) return updateBooking(booking);
    const user = event.target.closest('[data-deactivate-user]'); if (user) return deactivateUser(user);
    const ride = event.target.closest('[data-ride-verify]'); if (ride) return verifyRide(ride);
  });
  document.getElementById('refreshAdmin')?.addEventListener('click', loadData);
  document.getElementById('addAdminForm')?.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target; const message = document.getElementById('addAdminMsg');
    try { const result = await api('/admin/create-admin', { method: 'POST', body: { name: form.name.value.trim(), email: form.email.value.trim(), phone: form.phone.value.trim(), password: form.password.value, confirmPassword: form.confirmPassword.value } }); message.textContent = result.message; message.className = 'form-message'; form.reset(); await loadData(); } catch (error) { message.textContent = error.message; message.className = 'form-message form-message-error'; }
  });
  try { const saved = sessionStorage.getItem('revexAdminTab'); if (saved) showTab(saved); } catch {}
  await loadData();
});

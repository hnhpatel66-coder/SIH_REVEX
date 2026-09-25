let bookingItems = [];
let activeBookingStatus = 'upcoming';
let activeCategory = 'all';
let ratingContext = null;

function bookingStatusLabel(status) { return ({ payment_pending: 'Payment pending', pending_owner: 'Awaiting owner approval', confirmed: 'Confirmed', approved: 'Approved', completed: 'Completed', cancelled: 'Cancelled', rejected: 'Declined' })[status] || status; }
function statusBadge(status) { const className = ['confirmed', 'approved', 'completed'].includes(status) ? 'badge-approved' : ['cancelled', 'rejected'].includes(status) ? 'badge-rejected' : 'badge-pending'; return `<span class="badge ${className}">${escapeHtml(bookingStatusLabel(status))}</span>`; }
function renderBookingList() {
  const box = document.getElementById('bookingList'); if (!box) return;
  const status = activeBookingStatus;
  const visible = bookingItems.filter(item => {
    const statusMatch = status === 'upcoming' ? ['payment_pending', 'pending_owner', 'confirmed', 'approved'].includes(item.status) : item.status === status;
    if (!statusMatch) return false;
    if (activeCategory === 'all' || item.kind === 'Ride') return true;
    return (item.vehicleId?.category || item.vehicleId?.type || 'Other') === activeCategory;
  });
  if (!visible.length) { box.innerHTML = `<div class="empty">No ${status === 'upcoming' ? 'upcoming' : status} bookings match this filter.</div>`; return; }
  box.innerHTML = visible.map(item => {
    const isRide = item.kind === 'Ride'; const title = isRide ? `${escapeHtml(item.rideId?.from || '')} → ${escapeHtml(item.rideId?.to || '')}` : escapeHtml(item.vehicleId?.name || 'Vehicle rental');
    const date = isRide ? `${formatDate(item.rideId?.date)} · ${escapeHtml(item.rideId?.time || '')}` : `${formatDateTime(item.startDate)} – ${formatDateTime(item.endDate)}`;
    const quote = item.quote || {}; const canCancel = ['payment_pending', 'pending_owner', 'confirmed'].includes(item.status); const cancelAttr = isRide ? `data-cancel-ride="${item.id}"` : `data-cancel-rental="${item.id}"`;
    const agreement = !isRide && item.paymentStatus === 'paid' ? `<a class="btn btn-outline btn-small" href="agreement.html?bookingId=${encodeURIComponent(item.id)}">View agreement</a>` : '';
    const canRate = !isRide && ['confirmed', 'completed'].includes(item.status) && item.paymentStatus === 'paid' && !item.rating;
    return `<article class="booking-row"><div class="booking-info"><div class="badge-row">${statusBadge(item.status)}<span class="badge badge-muted">${escapeHtml(item.kind)}</span>${!isRide ? `<span class="badge badge-category">${escapeHtml(item.vehicleId?.category || item.vehicleId?.type || 'Other')}</span><span class="badge badge-fuel">${escapeHtml(item.vehicleId?.fuelType || 'Petrol')}</span>` : ''}</div><h3>${title}</h3><p class="card-meta">${date}</p>${!isRide ? `<div class="booking-breakdown"><span>Rental Amount ${formatMoney(quote.baseRentalAmount || item.baseAmount || 0)}</span><span>Additional ${formatMoney(quote.additionalCharges || item.additionalCharges || 0)}</span><span>Tax / Fees ${formatMoney(quote.taxFees || item.taxFees || 0)}</span><span>Paid ${formatMoney(quote.paidAmount || item.paidAmount || 0)}</span><span>Remaining ${formatMoney(quote.remainingAmount ?? item.remainingAmount ?? 0)}</span><strong>Grand Total ${formatMoney(quote.grandTotal || item.grandTotal || item.totalAmount || 0)}</strong></div>` : ''}${item.rating ? `<p class="rating-line">${'★'.repeat(Number(item.rating))}${'☆'.repeat(5 - Number(item.rating))} <small>${escapeHtml(item.comment || 'No comment')}</small></p>` : ''}</div><div class="booking-actions"><strong class="booking-amount">${formatMoney(item.quote?.grandTotal || item.grandTotal || item.totalAmount || 0)}</strong><span class="payment-label">${escapeHtml(item.paymentStatus || 'pending')}</span>${canCancel ? `<button class="btn btn-outline btn-small" ${cancelAttr}>Cancel</button>` : ''}${agreement}${canRate ? `<button class="btn btn-primary btn-small" data-rate="${item.id}" data-kind="Rental">Review / rate</button>` : ''}</div></article>`;
  }).join('');
}
function setStarRating(value) { document.querySelectorAll('#starPicker button').forEach(button => button.classList.toggle('selected', Number(button.dataset.rating) <= Number(value))); document.getElementById('ratingValue').textContent = `Selected ${value} star${value === '1' ? '' : 's'}`; }
function openRating(id, kind) { const item = bookingItems.find(booking => booking.id === id); if (!item) return; ratingContext = { id, kind }; document.getElementById('ratingTarget').textContent = kind === 'Ride' ? 'Rate your shared ride' : `Rate ${item.vehicleId?.name || 'this vehicle'}`; document.getElementById('ratingComment').value = ''; setStarRating(0); document.getElementById('ratingModal').classList.add('show'); }
async function reloadBookings() { const [rentals, rides] = await Promise.all([api('/bookings/my'), api('/rides/bookings/my').catch(() => [])]); bookingItems = [...rentals.map(item => ({ ...item, kind: 'Rental' })), ...rides.map(item => ({ ...item, kind: 'Ride' }))].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); renderBookingList(); }
document.addEventListener('DOMContentLoaded', async () => {
  if (!requireLogin()) return;
  const list = document.getElementById('bookingList'); if (!list) return;
  try { await reloadBookings(); } catch (error) { list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(item => item.classList.remove('active')); tab.classList.add('active'); activeBookingStatus = tab.dataset.status; renderBookingList(); }));
  document.getElementById('categoryFilters')?.addEventListener('click', event => { const chip = event.target.closest('[data-category]'); if (!chip) return; document.querySelectorAll('.filter-chip').forEach(item => item.classList.remove('active')); chip.classList.add('active'); activeCategory = chip.dataset.category; renderBookingList(); });
  list.addEventListener('click', async event => {
    const rate = event.target.closest('[data-rate]'); if (rate) { openRating(rate.dataset.rate, rate.dataset.kind); return; }
    const rental = event.target.closest('[data-cancel-rental]'); const ride = event.target.closest('[data-cancel-ride]'); if (!rental && !ride) return;
    if (!confirm('Cancel this booking?')) return;
    try { await api(rental ? `/bookings/${encodeURIComponent(rental.dataset.cancelRental)}/cancel` : `/rides/bookings/${encodeURIComponent(ride.dataset.cancelRide)}/cancel`, { method: 'POST' }); await reloadBookings(); showModal('Booking cancelled', 'The booking status has been updated.'); } catch (error) { alert(error.message); }
  });
  document.getElementById('starPicker')?.addEventListener('click', event => { const button = event.target.closest('[data-rating]'); if (button) setStarRating(button.dataset.rating); });
  document.getElementById('closeRating')?.addEventListener('click', () => document.getElementById('ratingModal').classList.remove('show'));
  document.getElementById('submitRating')?.addEventListener('click', async () => { if (!ratingContext) return; const selected = document.querySelector('#starPicker button.selected:last-of-type')?.dataset.rating; const all = [...document.querySelectorAll('#starPicker button')]; const rating = all.filter(button => button.classList.contains('selected')).pop()?.dataset.rating; if (!rating) return alert('Select a star rating.'); const endpoint = ratingContext.kind === 'Ride' ? `/rides/bookings/${encodeURIComponent(ratingContext.id)}/feedback` : `/bookings/${encodeURIComponent(ratingContext.id)}/feedback`; try { await api(endpoint, { method: 'POST', body: { rating: Number(rating), comment: document.getElementById('ratingComment').value.trim() } }); document.getElementById('ratingModal').classList.remove('show'); await reloadBookings(); showModal('Review submitted', 'Thank you for helping the REVEX community.'); } catch (error) { alert(error.message); } });
  try { const agreements = await api('/bookings/my-agreements'); const box = document.getElementById('agreementList'); if (box) box.innerHTML = agreements.length ? agreements.map(item => `<article class="booking-row"><div><strong>${escapeHtml(item.agreementId)}</strong><p class="card-meta">Booking ${escapeHtml(item.bookingId)} · ${escapeHtml(item.agreementStatus || 'Prepared')}</p></div><button class="btn btn-outline btn-small" data-download-agreement="${escapeHtml(item.bookingId)}">Download PDF</button></article>`).join('') : '<div class="empty">No agreements generated yet.</div>'; box?.addEventListener('click', event => { const button = event.target.closest('[data-download-agreement]'); if (button) downloadAgreement(button.dataset.downloadAgreement); }); } catch {}
});

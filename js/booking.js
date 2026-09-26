/* ============================================================================
 * MY BOOKINGS  (js/booking.js)
 *
 * One list for both flows, because a rider should not have to remember which
 * screen a booking came from:
 *   Rental -> /api/bookings/my
 *   Ride   -> /api/rides/bookings/my
 *
 * This file used to declare its OWN `statusBadge()` and `bookingStatusLabel()`,
 * silently shadowing the shared helpers in main.js, so the badge for a status
 * looked different here than everywhere else. It now uses the shared ones.
 *
 * Cancelling asks the server what the fee and refund will be FIRST
 * (`/cancellation-preview`), and shows those exact numbers in the confirmation,
 * instead of a generic "are you sure?" and a bare success message.
 * ========================================================================== */
(function (global) {
  'use strict';

  const R = global.REVEX;
  if (!R) return;
  const { api, escapeHtml, formatMoney, formatDate, formatDateTime, showToast, showModal, statusBadge, confirmAction, imageOrInitials } = R;

  let items = [];
  let activeStatus = 'upcoming';
  let activeCategory = 'all';
  let ratingContext = null;

  const UPCOMING = ['payment_pending', 'pending_owner', 'confirmed', 'approved'];

  function matchesStatus(item) {
    if (activeStatus === 'upcoming') return UPCOMING.includes(item.status);
    if (activeStatus === 'cancelled') return String(item.status).startsWith('cancelled') || item.status === 'rejected';
    return item.status === activeStatus;
  }

  function visible() {
    return items.filter(item => {
      if (!matchesStatus(item)) return false;
      if (activeCategory === 'all' || item.kind === 'Ride') return true;
      return (item.vehicleId?.category || item.vehicleId?.type || 'Other') === activeCategory;
    });
  }

  function quoteLines(item) {
    const quote = item.quote || {};
    if (item.kind === 'Ride') {
      const rows = [
        [`${quote.seats || item.seats} seat(s) × ${formatMoney(quote.price ?? item.pricePerSeat ?? 0)}`, formatMoney(quote.baseRideAmount ?? item.baseRideAmount ?? 0)],
        Number(quote.additionalCharges) > 0 ? ['Extras', formatMoney(quote.additionalCharges)] : null,
        Number(quote.platformFee) > 0 ? [`Platform fee (${quote.platformFeePercent}%)`, formatMoney(quote.platformFee)] : null,
        Number(quote.discountAmount) > 0 ? [`Discount (${quote.discountPercent}%)`, `− ${formatMoney(quote.discountAmount)}`] : null
      ].filter(Boolean);
      return rows.map(([label, value]) => `<span>${escapeHtml(label)}: <b>${escapeHtml(value)}</b></span>`).join('');
    }
    return [
      `Rental: <b>${formatMoney(quote.baseRentalAmount || item.baseAmount || 0)}</b>`,
      `Additional: <b>${formatMoney(quote.additionalCharges || item.additionalCharges || 0)}</b>`,
      `Discount: <b>−${formatMoney(quote.discountAmount || item.discountAmount || 0)}</b>`,
      `Tax / fees: <b>${formatMoney(quote.taxFees || item.taxFees || 0)}</b>`,
      `Paid: <b>${formatMoney(quote.paidAmount || item.paidAmount || 0)}</b>`,
      `Remaining: <b>${formatMoney(quote.remainingAmount ?? item.remainingAmount ?? 0)}</b>`
    ].map(html => `<span>${html}</span>`).join('');
  }

  function card(item) {
    const isRide = item.kind === 'Ride';
    const title = isRide
      ? `${escapeHtml(item.from || item.rideId?.from || '')} &rarr; ${escapeHtml(item.to || item.rideId?.to || '')}`
      : escapeHtml(item.vehicleId?.name || 'Vehicle rental');
    const when = isRide
      ? `${escapeHtml(formatDate(item.rideDate || item.rideId?.date))} · ${escapeHtml(item.rideTime || item.rideId?.time || '')}`
      : `${escapeHtml(formatDateTime(item.startDate))} – ${escapeHtml(formatDateTime(item.endDate))}`;
    const total = item.quote?.grandTotal ?? item.grandTotal ?? item.totalAmount ?? 0;
    const canCancel = ['payment_pending', 'pending_owner', 'confirmed'].includes(item.status);
    const canRate = (isRide ? ['confirmed', 'completed'].includes(item.status) : ['confirmed', 'completed'].includes(item.status))
      && item.paymentStatus === 'paid' && !item.rating;
    const image = isRide ? item.vehicleImage : (item.vehicleId?.vehiclePicture || item.vehicleId?.image);

    return `<article class="booking-row rvx-card rvx-card--quiet" data-booking-row="${escapeHtml(item.id)}">
      <div class="booking-info" style="min-width:0;display:flex;gap:12px">
        ${imageOrInitials(image, isRide ? (item.vehicleName || item.rideId?.vehicle) : (item.vehicleId?.name), { className: 'rvx-thumb rvx-thumb--sm', alt: '' })}
        <div style="min-width:0">
          <div class="rvx-chips" style="margin-bottom:6px">
            ${statusBadge(item.status)}
            ${statusBadge(item.paymentStatus)}
            ${item.paymentMethod === 'demo' ? statusBadge('pending', 'test payment') : ''}
            <span class="rvx-chip">${isRide ? 'Ride sharing' : escapeHtml(item.vehicleId?.category || item.vehicleId?.type || 'Rental')}</span>
          </div>
          <h3 class="rvx-card__title" style="font-size:1rem">${title}</h3>
          <p class="card-meta">${when}</p>
          ${isRide ? `<p class="card-meta">Driver: ${escapeHtml(item.rideSnapshot?.driver || item.rideId?.driver || '—')} · ${escapeHtml(item.vehicleName || item.rideId?.vehicle || '')}</p>` : ''}
          <div class="booking-breakdown">${quoteLines(item)}</div>
          <strong>Total ${formatMoney(total)}</strong>
          ${item.cancellation?.reason ? `<p class="status-error">${escapeHtml(item.cancellation.cancellationBy ? `Cancelled by ${item.cancellation.cancelledBy}` : 'Cancelled')}: ${escapeHtml(item.cancellation.reason)} · fee ${formatMoney(item.cancellation.cancellationFee || 0)} · refund ${formatMoney(item.cancellation.refundAmount || 0)}</p>` : ''}
          ${item.rating ? `<p class="rating-line">${'★'.repeat(Number(item.rating))}${'☆'.repeat(5 - Number(item.rating))} <small>${escapeHtml(item.comment || 'No comment')}</small></p>` : ''}
        </div>
      </div>
      <div class="booking-actions">
        <span class="payment-label">${escapeHtml(item.paymentStatus || 'pending')}</span>
        ${canCancel ? `<button class="btn btn-outline btn-small" type="button" ${isRide ? `data-cancel-ride="${escapeHtml(item.id)}"` : `data-cancel-rental="${escapeHtml(item.id)}"`}>Cancel</button>` : ''}
        ${!isRide && item.paymentStatus === 'paid' ? `<a class="btn btn-outline btn-small" href="agreement.html?bookingId=${encodeURIComponent(item.id)}">View agreement</a>` : ''}
        ${canRate ? `<button class="btn btn-primary btn-small" data-rate="${escapeHtml(item.id)}" data-kind="${isRide ? 'Ride' : 'Rental'}" type="button">Review / rate</button>` : ''}
      </div>
    </article>`;
  }

  function render() {
    const box = document.getElementById('bookingList');
    if (!box) return;
    const rows = visible();
    box.innerHTML = rows.length
      ? rows.map(card).join('')
      : `<div class="rvx-empty"><h3>Nothing here yet</h3><p>No ${activeStatus === 'upcoming' ? 'upcoming' : escapeHtml(activeStatus)} bookings match this filter.</p><a class="rvx-btn rvx-btn--outline" href="find-ride.html">Find a ride</a> <a class="rvx-btn rvx-btn--outline" href="rental.html">Rent a vehicle</a></div>`;
  }

  async function reload() {
    const [rentals, rides] = await Promise.all([api('/bookings/my'), api('/rides/bookings/my').catch(() => [])]);
    items = [
      ...rentals.map(item => ({ ...item, kind: 'Rental' })),
      ...rides.map(item => ({ ...item, kind: 'Ride' }))
    ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    render();
  }

  /* ---------------------------------------------------------- cancelling */

  async function cancelBooking(button) {
    const isRide = Boolean(button.dataset.cancelRide);
    const id = isRide ? button.dataset.cancelRide : button.dataset.cancelRental;
    const previewPath = isRide ? `/rides/bookings/${encodeURIComponent(id)}/cancellation-preview` : `/bookings/${encodeURIComponent(id)}/cancellation-preview`;

    // The fee and refund shown here are the ones the server will apply.
    let preview = null;
    try { preview = await api(previewPath); } catch { /* the confirm still works, just without a preview */ }

    const feeLine = preview
      ? (preview.withinFreeWindow
        ? `You are inside the free-cancellation window (${preview.freeWindowHours} hour(s) before the start), so the full amount is refunded.`
        : `A cancellation fee of ${formatMoney(preview.cancellationFee)} is retained and ${formatMoney(preview.refundAmount)} is refunded.`)
      : 'The cancellation policy decides the fee and the refund.';

    const answer = await confirmAction({
      title: 'Cancel this booking?',
      message: `${preview?.cancellable === false ? 'This booking can no longer be cancelled. ' : ''}${feeLine}`,
      confirmLabel: 'Cancel booking', tone: 'danger',
      reasonLabel: 'Reason (recorded on the booking)', reasonRequired: false
    });
    if (!answer) return;

    button.disabled = true;
    const original = button.innerHTML;
    button.innerHTML = '<span class="rvx-spinner" aria-hidden="true"></span>';
    try {
      const path = isRide
        ? `/rides/bookings/${encodeURIComponent(id)}/cancel`
        : `/bookings/${encodeURIComponent(id)}/cancel`;
      const result = await api(path, { method: 'POST', body: { reason: answer.reason || 'Cancelled by the renter.' } });
      showModal('Booking cancelled', result.message || 'The booking has been cancelled.');
      showToast(result.message || 'The booking has been cancelled.', 'ok', 8000);
      if (result.refund?.gatewayError) showToast(`Automatic refund failed: ${result.refund.gatewayError}`, 'bad', 12000);
      await reload();
    } catch (error) {
      showToast(error.message, 'bad', 8000);
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  /* -------------------------------------------------------------- rating */

  function setStarRating(value) {
    document.querySelectorAll('#starPicker button').forEach(button => button.classList.toggle('selected', Number(button.dataset.rating) <= Number(value)));
    const label = document.getElementById('ratingValue');
    if (label) label.textContent = value ? `Selected ${value} star${value === '1' ? '' : 's'}` : 'No rating selected';
  }

  function openRating(id, kind) {
    const item = items.find(booking => booking.id === id);
    if (!item) return;
    ratingContext = { id, kind };
    document.getElementById('ratingTarget').textContent = kind === 'Ride' ? 'Rate your shared ride' : `Rate ${item.vehicleId?.name || 'this vehicle'}`;
    document.getElementById('ratingComment').value = '';
    setStarRating(0);
    document.getElementById('ratingModal').classList.add('show');
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!R.requireLogin()) return;
    const list = document.getElementById('bookingList');
    if (!list) return;
    try { await reload(); } catch (error) { list.innerHTML = `<div class="rvx-empty"><h3>Bookings could not be loaded</h3><p>${escapeHtml(error.message)}</p></div>`; }

    // Deep link: bookings.html?bookingId=... reveals the matching booking even if
    // the current status tab would otherwise filter it out.
    const focusBooking = new URLSearchParams(location.search).get('bookingId');
    if (focusBooking) {
      if (items.some(item => item.id === focusBooking)) {
        activeStatus = 'all';
        document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.status === 'all'));
        render();
        const row = list.querySelector(`[data-booking-row="${CSS.escape(focusBooking)}"]`);
        if (row) { row.classList.add('is-highlighted'); row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      } else {
        showModal('Booking not found', `No booking with id ${focusBooking} exists in your account.`);
      }
    }

    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
      tab.classList.add('active');
      activeStatus = tab.dataset.status;
      render();
    }));
    document.getElementById('categoryFilters')?.addEventListener('click', event => {
      const chip = event.target.closest('[data-category]');
      if (!chip) return;
      document.querySelectorAll('[data-category]').forEach(item => item.classList.remove('active'));
      chip.classList.add('active');
      activeCategory = chip.dataset.category;
      render();
    });

    list.addEventListener('click', event => {
      const rate = event.target.closest('[data-rate]');
      if (rate) { openRating(rate.dataset.rate, rate.dataset.kind); return; }
      const rental = event.target.closest('[data-cancel-rental]');
      if (rental) { cancelBooking(rental); return; }
      const ride = event.target.closest('[data-cancel-ride]');
      if (ride) cancelBooking(ride);
    });

    document.getElementById('starPicker')?.addEventListener('click', event => {
      const button = event.target.closest('[data-rating]');
      if (button) setStarRating(button.dataset.rating);
    });
    document.getElementById('closeRating')?.addEventListener('click', () => document.getElementById('ratingModal').classList.remove('show'));
    document.getElementById('submitRating')?.addEventListener('click', async event => {
      if (!ratingContext) return;
      const selected = [...document.querySelectorAll('#starPicker button.selected')].pop();
      if (!selected) { showToast('Select a star rating first.', 'warn'); return; }
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const endpoint = ratingContext.kind === 'Ride'
          ? `/rides/bookings/${encodeURIComponent(ratingContext.id)}/feedback`
          : `/bookings/${encodeURIComponent(ratingContext.id)}/feedback`;
        await api(endpoint, { method: 'POST', body: { rating: Number(selected.dataset.rating), comment: document.getElementById('ratingComment').value.trim() } });
        document.getElementById('ratingModal').classList.remove('show');
        await reload();
        showModal('Review submitted', 'Thank you for helping the REVEX community.');
      } catch (error) { showToast(error.message, 'bad', 8000); }
      finally { button.disabled = false; }
    });

    try {
      const agreements = await api('/bookings/my-agreements');
      const box = document.getElementById('agreementList');
      if (box) {
        box.innerHTML = agreements.length
          ? agreements.map(item => `<article class="booking-row"><div><strong>${escapeHtml(item.agreementId)}</strong><p class="card-meta">Booking ${escapeHtml(item.bookingId)} · ${escapeHtml(item.agreementStatus || 'Prepared')}</p></div><button class="btn btn-outline btn-small" data-download-agreement="${escapeHtml(item.bookingId)}" type="button">Download PDF</button></article>`).join('')
          : '<div class="empty">No agreements generated yet.</div>';
        box.addEventListener('click', event => {
          const button = event.target.closest('[data-download-agreement]');
          if (button) global.downloadAgreement(button.dataset.downloadAgreement);
        });
      }
    } catch { /* agreements are optional */ }
  });

  global.RevexBookings = { reload, render };
})(window);

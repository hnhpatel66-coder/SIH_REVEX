/* ============================================================================
 * OWNER: RIDE BOOKING REQUESTS  (js/ride-requests.js)
 *
 * ride-requests.html is the owner's counterpart to Find a Ride: the paid seat
 * requests people have made on the rides this owner published.
 *
 * Two things this screen is careful about:
 *   1. It only ever lists PAID requests. An unpaid seat hold is an internal
 *      checkout state, not a request the owner has to act on, so showing it
 *      would be asking the owner to approve a payment that never happened.
 *   2. Rejecting a paid request refunds the rider through the same centralised
 *      policy as a cancellation, and the screen reports the refund amount the
 *      server calculated rather than guessing one.
 * ========================================================================== */
(function (global) {
  'use strict';

  const R = global.REVEX;
  if (!R) return;
  if (!R.requireRole('owner', 'admin')) return;

  const { api, escapeHtml, formatMoney, formatDate, formatDateTime, showToast, statusBadge, imageOrInitials, confirmAction } = R;

  const listBox = document.getElementById('rideRequestList');
  const statsBox = document.getElementById('rideRequestStats');
  const filterBox = document.getElementById('rideRequestFilter');
  const ridesBox = document.getElementById('rideOwnerRides');
  let filter = 'pending_owner';

  function filterChips() {
    if (!filterBox) return;
    const options = [
      ['pending_owner', 'Awaiting my approval'],
      ['confirmed', 'Approved'],
      ['rejected', 'Declined'],
      ['completed', 'Completed'],
      ['cancelled', 'Cancelled'],
      ['all', 'All']
    ];
    filterBox.replaceChildren(...options.map(([value, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rvx-btn rvx-btn--sm ' + (filter === value ? 'rvx-btn--primary' : 'rvx-btn--ghost');
      button.textContent = label;
      button.addEventListener('click', () => { filter = value; filterChips(); load(); });
      return button;
    }));
  }

  function stats(all) {
    if (!statsBox) return;
    const count = status => all.filter(row => row.status === status).length;
    const revenue = all
      .filter(row => row.paymentStatus === 'paid' && ['confirmed', 'completed'].includes(row.status))
      .reduce((sum, row) => sum + Number(row.totalAmount || 0), 0);
    const seats = all
      .filter(row => ['confirmed', 'completed'].includes(row.status))
      .reduce((sum, row) => sum + Number(row.seats || 0), 0);
    const cards = [
      ['Awaiting approval', count('pending_owner'), 'warn'],
      ['Approved seats', count('confirmed'), 'ok'],
      ['Declined', count('rejected'), ''],
      ['Completed', count('completed'), ''],
      ['Seats filled', seats, ''],
      ['Ride revenue', formatMoney(revenue), 'accent']
    ];
    statsBox.innerHTML = cards.map(([label, value, tone]) => `
      <div class="rvx-stat ${tone ? `rvx-stat--${tone}` : ''}">
        <span class="rvx-stat__label">${escapeHtml(label)}</span>
        <span class="rvx-stat__value">${escapeHtml(String(value))}</span>
      </div>`).join('');
  }

  function requestCard(row) {
    const canDecide = row.status === 'pending_owner';
    const snapshot = row.rideSnapshot || {};
    const refund = row.refund?.amount ?? row.cancellation?.refundAmount;
    return `
      <article class="rvx-card" data-request="${escapeHtml(row.id)}">
        <div class="rvx-card__head">
          <div class="rvx-user" style="min-width:0">
            ${imageOrInitials(row.userId?.photo, row.userName, { className: 'rvx-user-avatar', alt: '' })}
            <span style="min-width:0">
              <span class="rvx-user__name">${escapeHtml(row.userName || 'Rider')}</span>
              <span class="rvx-user__sub">${escapeHtml(row.userEmail || '')}${row.userPhone ? ` · ${escapeHtml(row.userPhone)}` : ''}</span>
            </span>
          </div>
          ${statusBadge(row.status)}
        </div>

        <div class="rvx-thumbs" style="display:flex;gap:10px;align-items:center">
          ${imageOrInitials(row.vehicleImage || snapshot.vehicleImage, row.vehicleName || snapshot.vehicle, { className: 'rvx-thumb rvx-thumb--xs', alt: '' })}
          <div style="min-width:0">
            <strong>${escapeHtml(row.vehicleName || snapshot.vehicle || 'Vehicle')}</strong>
            <div class="rvx-card__meta">${escapeHtml(row.from || snapshot.from || '')} &rarr; ${escapeHtml(row.to || snapshot.to || '')}</div>
            <div class="rvx-card__meta">${escapeHtml(formatDate(row.rideDate || snapshot.date))} · ${escapeHtml(row.rideTime || snapshot.time || '')}</div>
          </div>
        </div>

        <dl class="rvx-lines">
          <div class="rvx-line"><dt>Seats requested</dt><dd>${escapeHtml(String(row.seats ?? 0))}</dd></div>
          <div class="rvx-line"><dt>Paid</dt><dd>${formatMoney(row.paidAmount ?? row.totalAmount)} ${row.paymentMethod === 'demo' ? statusBadge('pending', 'test') : statusBadge('paid')}</dd></div>
          <div class="rvx-line rvx-line--total"><dt>Amount received</dt><dd>${formatMoney(row.totalAmount)}</dd></div>
        </dl>

        ${row.cancellation?.reason ? `<p class="rvx-notice rvx-notice--warn"><div><strong>Cancellation</strong>${escapeHtml(row.cancellation.reason)}${row.cancellation.cancelledBy ? ` (by ${escapeHtml(row.cancellation.cancelledBy)})` : ''}${refund !== undefined ? ` · Refund ${formatMoney(refund)}` : ''}</div></p>` : ''}
        ${row.ownerDecision?.reason ? `<p class="rvx-card__meta">Your decision: ${escapeHtml(row.ownerDecision.decision)}${row.ownerDecision.reason ? ` — ${escapeHtml(row.ownerDecision.reason)}` : ''}</p>` : ''}
        <p class="rvx-card__meta">Requested ${escapeHtml(formatDateTime(row.createdAt))} · Booking ${escapeHtml(String(row.id).slice(-8))}</p>

        <div class="rvx-card__actions">
          ${canDecide ? `
            <button type="button" class="rvx-btn rvx-btn--ok rvx-btn--sm" data-approve="${escapeHtml(row.id)}">Approve seat</button>
            <button type="button" class="rvx-btn rvx-btn--danger rvx-btn--sm" data-reject="${escapeHtml(row.id)}">Decline &amp; refund</button>
          ` : ''}
          ${row.status === 'confirmed' ? `<button type="button" class="rvx-btn rvx-btn--outline rvx-btn--sm" data-complete="${escapeHtml(row.id)}">Mark completed</button>` : ''}
          ${['pending_owner', 'confirmed'].includes(row.status) ? `<button type="button" class="rvx-btn rvx-btn--ghost rvx-btn--sm" data-cancel="${escapeHtml(row.id)}">Cancel seat</button>` : ''}
        </div>
      </article>`;
  }

  async function load() {
    if (!listBox) return;
    listBox.innerHTML = '<div class="rvx-grid"><div class="rvx-skeleton" style="height:220px"></div><div class="rvx-skeleton" style="height:220px"></div></div>';
    try {
      const [all, mine] = await Promise.all([
        api('/rides/requests?status=all'),
        api('/rides/mine')
      ]);
      stats(all);
      renderOwnerRides(mine);
      const rows = filter === 'all' ? all : all.filter(row => row.status === filter);
      listBox.innerHTML = rows.length
        ? rows.map(requestCard).join('')
        : `<div class="rvx-empty"><h3>Nothing to review</h3><p>Paid seat requests for your rides appear here. A request only shows up after the rider has actually paid.</p></div>`;
    } catch (error) {
      listBox.innerHTML = `<div class="rvx-empty"><h3>Requests could not be loaded</h3><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  function renderOwnerRides(rides) {
    if (!ridesBox) return;
    const buckets = {
      pending: rides.filter(ride => ride.status === 'pending'),
      approved: rides.filter(ride => ['approved', 'available'].includes(ride.status)),
      rejected: rides.filter(ride => ride.status === 'rejected'),
      cancelled: rides.filter(ride => ['cancelled', 'removed'].includes(ride.status)),
      completed: rides.filter(ride => ride.status === 'completed'),
      active: rides.filter(ride => ride.status === 'active'),
      upcoming: rides.filter(ride => ['pending', 'approved', 'available'].includes(ride.status) && new Date(ride.date) >= new Date())
    };
    ridesBox.innerHTML = `
      <div class="rvx-stats">
        ${Object.entries({ Pending: buckets.pending.length, Approved: buckets.approved.length, Rejected: buckets.rejected.length, Cancelled: buckets.cancelled.length, Completed: buckets.completed.length, 'In progress': buckets.active.length, Upcoming: buckets.upcoming.length })
        .map(([label, value]) => `<div class="rvx-stat"><span class="rvx-stat__label">${escapeHtml(label)}</span><span class="rvx-stat__value">${value}</span></div>`).join('')}
      </div>`;
  }

  async function decide(id, decision, button) {
    if (decision === 'approve') {
      const original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="rvx-spinner" aria-hidden="true"></span>';
      try {
        const result = await api(`/rides/bookings/${encodeURIComponent(id)}/decision`, { method: 'POST', body: { decision: 'approve' } });
        showToast(result.message || 'Seat approved.', 'ok');
        await load();
      } catch (error) { showToast(error.message, 'bad', 8000); button.disabled = false; button.innerHTML = original; }
      return;
    }
    const answer = await confirmAction({
      title: 'Decline this seat request?',
      message: 'The rider has already paid. Declining refunds them under the REVEX cancellation policy, keeping only the policy fee if the free-cancellation window has passed.',
      confirmLabel: 'Decline and refund',
      tone: 'danger',
      reasonLabel: 'Reason (the rider sees this)',
      reasonRequired: true
    });
    if (!answer) return;
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="rvx-spinner" aria-hidden="true"></span>';
    try {
      const result = await api(`/rides/bookings/${encodeURIComponent(id)}/decision`, { method: 'POST', body: { decision: 'reject', reason: answer.reason } });
      showToast(result.message || 'Seat request declined.', 'ok', 8000);
      if (result.refund?.gatewayError) showToast(`Automatic refund failed: ${result.refund.gatewayError}`, 'bad', 12000);
      await load();
    } catch (error) { showToast(error.message, 'bad', 8000); button.disabled = false; button.innerHTML = original; }
  }

  async function cancelSeat(id, button) {
    const answer = await confirmAction({
      title: 'Cancel this seat?',
      message: 'The seat is released and the rider is refunded under the REVEX cancellation policy. The booking record is kept for the audit trail.',
      confirmLabel: 'Cancel the seat',
      tone: 'danger',
      reasonLabel: 'Reason (the rider sees this)',
      reasonRequired: true
    });
    if (!answer) return;
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="rvx-spinner" aria-hidden="true"></span>';
    try {
      const result = await api(`/rides/bookings/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { reason: answer.reason } });
      showToast(result.message || 'Seat cancelled.', 'ok', 8000);
      await load();
    } catch (error) { showToast(error.message, 'bad', 8000); button.disabled = false; button.innerHTML = original; }
  }

  document.addEventListener('click', async event => {
    const approve = event.target.closest('[data-approve]');
    if (approve) return decide(approve.dataset.approve, 'approve', approve);
    const reject = event.target.closest('[data-reject]');
    if (reject) return decide(reject.dataset.reject, 'reject', reject);
    const cancel = event.target.closest('[data-cancel]');
    if (cancel) return cancelSeat(cancel.dataset.cancel, cancel);
    const complete = event.target.closest('[data-complete]');
    if (complete) {
      complete.disabled = true;
      try {
        const result = await api(`/rides/bookings/${encodeURIComponent(complete.dataset.complete)}/complete`, { method: 'POST', body: {} });
        showToast(result.message || 'Ride completed.', 'ok');
        await load();
      } catch (error) { showToast(error.message, 'bad'); complete.disabled = false; }
    }
  });

  document.addEventListener('DOMContentLoaded', () => { filterChips(); load(); });
})(window);

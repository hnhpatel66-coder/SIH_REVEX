/* ============================================================================
 * ADMIN CONTROL CENTRE  (js/admin.js)
 *
 * Rebuilt in 1.3 around the single endpoint GET /api/admin/owners/:id, which
 * returns the whole Owner Summary dashboard in one document. Previously the
 * screen stitched together four requests, so it regularly showed a mixture of
 * real numbers and zeros from a request that had not finished.
 *
 * Additions in 1.3:
 *   - Ride Approvals tab: the full approval queue with owner, vehicle, photo,
 *     registration, route, timing, seats, price and documents.
 *   - Payments tab: the gateway ledger.
 *   - Chat tab: the admin's own assistant conversation.
 *   - Vehicle actions inside the Owner Summary (approve, reject, disable,
 *     remove) — previously only "Open" and "Delete" were reachable there.
 *   - Every destructive action asks for a reason and shows the server's own
 *     result, including refund amounts. No `prompt()` / bare `confirm()`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const R = global.REVEX;
  if (!R) return;
  const { api, escapeHtml, formatMoney, formatDate, formatDateTime, showToast, statusBadge, imageOrInitials, confirmAction, getStoredUser, clearSession } = R;

  const state = {
    summary: null,
    vehicles: [],
    owners: [],
    ownerDetail: null,
    bookings: [],
    rideApprovals: [],
    payments: [],
    users: [],
    income: null,
    profile: null,
    agreements: [],
    missingAgreements: [],
    filters: {
      vehicle: 'all',
      owner: 'all',
      ownerSearch: '',
      booking: 'all',
      ride: 'pending',
      payment: 'all',
      user: 'all',
      agreement: 'all',
      agreementSearch: ''
    },
    activeTab: 'dashboard',
    activeOwnerId: null,
    activeVehicleId: null
  };

  /* ------------------------------------------------------------- chrome */

  function adminMessage(message, error = false) {
    const box = document.getElementById('adminMessage');
    if (!box) return;
    box.textContent = message;
    box.className = `form-message${error ? ' form-message-error' : ''}`;
    if (message) setTimeout(() => { if (box.textContent === message) box.textContent = ''; }, 6000);
  }

  function statCard(label, value, note) {
    return `<article class="stat-card"><span class="eyebrow">${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(note || '')}</small></article>`;
  }

  function stat(label, value, hint = '', tone = '') {
    return `<div class="rvx-stat${tone ? ` rvx-stat--${tone}` : ''}"><span class="rvx-stat__label">${escapeHtml(label)}</span><span class="rvx-stat__value">${escapeHtml(String(value))}</span>${hint ? `<span class="rvx-stat__hint">${escapeHtml(hint)}</span>` : ''}</div>`;
  }

  function row(strong, small, right = '') {
    return `<div class="list-row"><div><strong>${escapeHtml(strong)}</strong><small>${escapeHtml(small)}</small></div>${right}</div>`;
  }

  /**
   * The API reports the OWNER's share rate (0.9). Every caption that shows a
   * percentage has to know which side of the split it is describing, because
   * using the owner rate for the platform's share labelled a 10% commission as
   * "90% service fee".
   */
  function ownerSharePercent(rate) {
    return Math.round((Number(rate) || 0.9) * 100);
  }

  function documents(vehicle) {
    const list = vehicle?.documents || [];
    if (!list.length) return '<span class="muted-text">No documents uploaded</span>';
    return `<div class="document-list">${list.map(item => {
      const dataUrl = item.dataUrl || '';
      const isImage = String(item.mimeType || dataUrl).startsWith('image/') || String(dataUrl).startsWith('data:image/');
      const preview = dataUrl && isImage ? `<img class="document-thumb" src="${escapeHtml(dataUrl)}" alt="${escapeHtml(item.label || item.type)}">` : '';
      const links = dataUrl
        ? `<a href="${escapeHtml(dataUrl)}" target="_blank" rel="noopener">Open</a> <a href="${escapeHtml(dataUrl)}" download="${escapeHtml(item.fileName || `${item.type}.bin`)}">Download</a>`
        : `<span>${escapeHtml(item.fileName || 'File name only')}</span>`;
      return `<div class="document-item">${preview}<div><b>${escapeHtml(item.label || item.type)}</b><small>${escapeHtml(item.fileName || 'Uploaded file')} · ${escapeHtml(item.status || 'pending')}</small><br>${links}</div></div>`;
    }).join('')}</div>`;
  }

  function busy(button, on = true) {    if (!button) return;
    if (on) {
      button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="rvx-spinner" aria-hidden="true"></span>';
    } else {
      button.disabled = false;
      if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
    }
  }

  /* ---------------------------------------------------------- dashboard */

  function renderStats() {
    const box = document.getElementById('adminStats');
    const summary = state.summary;
    if (!box || !summary) return;
    /* The API reports the OWNER's rate, so the platform rate is its complement.
       Labelling the platform share with the owner's percentage is how a 10%
       commission ended up captioned "90% service fee" on the dashboard. */
    const ownerRate = ownerSharePercent(summary.ownerShareRate);
    box.innerHTML = [
      statCard('Users', summary.users, 'Active accounts'),
      statCard('Owners', summary.owners, 'Owner accounts'),
      statCard('Vehicles', summary.vehicles, `${summary.approvedVehicles} approved`),
      statCard('Pending vehicles', summary.pendingVehicleVerification, 'Awaiting documents'),
      statCard('Ride offers', summary.rides, `${summary.pendingRideApprovals || 0} pending`),
      statCard('Rental bookings', summary.bookings, 'Rental records'),
      statCard('Total revenue', formatMoney(summary.totalRevenue), 'Paid, non-cancelled'),
      statCard('Platform share', formatMoney(summary.platformEarnings ?? summary.commission), `${100 - ownerRate}% service fee`),
      statCard('Owner payout', formatMoney(summary.ownerPayout), `${ownerRate}% of gross`),
      statCard('Rental revenue', formatMoney(summary.rentalRevenue || 0), 'Rentals only'),
      statCard('Ride revenue', formatMoney(summary.rideRevenue || 0), 'Rides only')
    ].join('');
  }

  function renderApprovalSummary() {
    const box = document.getElementById('adminApprovalSummary');
    if (!box) return;
    const pendingVehicles = state.vehicles.filter(vehicle => vehicle.status === 'pending');
    const pendingRides = state.rideApprovals.filter(ride => ride.status === 'pending');
    const pendingBookings = state.bookings.filter(booking => booking.status === 'pending_owner');
    const section = (title, items, render) => `
      <h4 style="margin:14px 0 6px">${escapeHtml(title)} (${items.length})</h4>
      ${items.length ? items.slice(0, 4).map(render).join('') : '<div class="empty">Nothing waiting.</div>'}`;
    box.innerHTML = [
      section('Vehicles awaiting approval', pendingVehicles, vehicle => row(vehicle.name, `${vehicle.owner?.name || 'Owner'} · ${vehicle.numberPlate || 'No plate'}`,
        `<button class="btn btn-primary btn-small" data-verify="${escapeHtml(vehicle.id)}" data-decision="approve" type="button">Approve</button>`)),
      section('Ride offers awaiting approval', pendingRides, ride => row(`${ride.from} → ${ride.to}`, `${ride.driverName || 'Owner'} · ${formatDate(ride.date)}`,
        `<button class="btn btn-primary btn-small" data-ride-verify="${escapeHtml(ride.id)}" data-decision="approve" type="button">Approve</button>`)),
      section('Rental requests awaiting an owner', pendingBookings, booking => row(booking.vehicleName, `${booking.userName} · ${formatMoney(booking.grandTotal)}`, ''))
    ].join('');
  }

  function renderActivity() {
    const box = document.getElementById('adminActivity');
    if (!box) return;
    const rental = state.bookings.slice(0, 4).map(item => row(item.vehicleName || 'Vehicle', `${item.userName} · ${formatDateTime(item.createdAt)}`, statusBadge(item.status)));
    box.innerHTML = rental.length ? `<h4 style="margin:0 0 6px">Rental bookings</h4>${rental.join('')}` : '<div class="empty">No rental activity yet.</div>';
  }

  /* ----------------------------------------------------------- vehicles */

  function vehicleRow(vehicle) {
    const status = vehicle.status || 'pending';
    // An approved vehicle hidden by a future "available from" date is invisible
    // to renters, so the admin is told rather than left guessing.
    const hiddenUntil = status === 'approved' && vehicle.availableFrom && new Date(vehicle.availableFrom) > new Date()
      ? `<p class="notice">Approved, but hidden from the renter portal until ${escapeHtml(formatDate(vehicle.availableFrom))} (the owner's "available from" date).</p>`
      : '';
    return `<article class="moderation-card"><div class="moderation-main">
      <div class="badge-row">${statusBadge(status)}<span class="badge badge-category">${escapeHtml(vehicle.category || vehicle.type || 'Other')}</span><span class="badge badge-fuel">${escapeHtml(vehicle.fuelType || 'Petrol')}</span></div>
      <div class="rvx-user" style="margin:10px 0">
        ${imageOrInitials(vehicle.image, vehicle.name, { className: 'rvx-thumb rvx-thumb--sm', alt: '' })}
        <span style="min-width:0"><span class="rvx-user__name">${escapeHtml(vehicle.name)}</span>
        <span class="rvx-user__sub">${escapeHtml([vehicle.brand, vehicle.model].filter(Boolean).join(' '))} · ${escapeHtml(vehicle.numberPlate || 'No plate')}</span></span>
      </div>
      <p class="card-meta">${escapeHtml(vehicle.location || '-')} · ${Number(vehicle.currentKm || 0).toLocaleString('en-IN')} km · ${formatMoney(vehicle.price)}/${escapeHtml(vehicle.priceUnit || 'hour')}${vehicle.discountPercent ? ` · ${vehicle.discountPercent}% discount` : ''}</p>
      <p class="card-meta">Owner: ${escapeHtml(vehicle.owner?.name || 'Unknown')}${vehicle.owner?.email ? ` (${escapeHtml(vehicle.owner.email)})` : ''}${vehicle.owner?.phone ? ` · ${escapeHtml(vehicle.owner.phone)}` : ''}</p>
      ${hiddenUntil}
      ${vehicle.rejectionReason ? `<p class="status-error">Rejection reason: ${escapeHtml(vehicle.rejectionReason)}</p>` : ''}
      ${vehicle.removalReason ? `<p class="status-error">Removal reason: ${escapeHtml(vehicle.removalReason)}</p>` : ''}
      <div class="document-section"><h4>Uploaded documents</h4>${documents(vehicle)}</div>
    </div><div class="moderation-actions">
      <button class="btn btn-outline" type="button" data-open-vehicle="${escapeHtml(vehicle.id)}">Open</button>
      ${['pending', 'rejected', 'removed'].includes(status) ? `<button class="btn btn-primary" type="button" data-verify="${escapeHtml(vehicle.id)}" data-decision="approve">Approve</button>` : ''}
      ${status !== 'approved' && status !== 'rejected' ? `<button class="btn btn-outline" type="button" data-verify="${escapeHtml(vehicle.id)}" data-decision="reject">Reject</button>` : ''}
      ${status === 'approved' ? `<button class="btn btn-outline" type="button" data-vehicle-status="${escapeHtml(vehicle.id)}" data-next="removed" data-vehicle-name="${escapeHtml(vehicle.name || '')}">Remove</button>` : ''}
      ${status !== 'removed' ? `<button class="btn btn-danger" type="button" data-remove-vehicle="${escapeHtml(vehicle.id)}" data-vehicle-name="${escapeHtml(vehicle.name || '')}">Delete</button>` : ''}
    </div></article>`;
  }

  function renderVehicles() {
    const box = document.getElementById('adminVehicles');
    if (!box) return;
    const list = state.filters.vehicle === 'all' ? state.vehicles : state.vehicles.filter(vehicle => vehicle.status === state.filters.vehicle);
    box.innerHTML = list.length
      ? list.map(vehicleRow).join('')
      : '<div class="empty">No vehicles in this status.</div>';
  }

  async function openVehicle(id) {
    const box = document.getElementById('adminVehicleDetail');
    if (!box) return;
    box.innerHTML = '<div class="detail-panel" style="margin-top:18px"><div class="rvx-skeleton" style="height:180px"></div></div>';
    try {
      const data = await api(`/admin/vehicles/${encodeURIComponent(id)}`);
      state.activeVehicleId = id;
      const v = data.vehicle || {};
      const s = data.stats || {};
      box.innerHTML = `<article class="detail-panel owner-detail-panel" style="margin-top:18px">
        <div class="panel-heading"><div><span class="eyebrow">VEHICLE DETAIL</span><h2>${escapeHtml(v.name || 'Vehicle')}</h2><p>${escapeHtml(v.numberPlate || 'No plate')} · ${escapeHtml(v.category || v.type || '')}</p></div><button class="btn btn-outline" id="closeVehicleDetail" type="button">Close</button></div>
        <div class="rvx-stats">
          ${stat('Status', statusLabelShort(v.status), '', v.status === 'approved' ? 'ok' : '')}
          ${stat('Bookings', s.totalBookings || 0)}
          ${stat('Completed', s.completedBookings || 0)}
          ${stat('Active', s.activeBookings || 0)}
          ${stat('Cancelled', s.cancelledBookings || 0, '', s.cancelledBookings ? 'bad' : '')}
          ${stat('Gross revenue', formatMoney(s.grossEarnings || 0))}
          ${stat('Owner revenue', formatMoney(s.ownerEarnings || 0), '', 'accent')}
        </div>
        <div class="rvx-user" style="margin:14px 0">
          ${imageOrInitials(v.image, v.name, { className: 'rvx-thumb rvx-thumb--sm', alt: '' })}
          <span style="min-width:0"><span class="rvx-user__name">${escapeHtml(v.owner?.name || 'Owner')}</span><span class="rvx-user__sub">${escapeHtml(v.owner?.email || '')}${v.owner?.phone ? ` · ${escapeHtml(v.owner.phone)}` : ''}</span></span>
        </div>
        <h3>Documents</h3>${documents(v)}
        <h3 style="margin-top:20px">Rent bookings (${(data.bookings || []).length})</h3>
        ${(data.bookings || []).length ? (data.bookings || []).map(booking => row(booking.userName || 'Renter', `${formatDate(booking.startDate)} → ${formatDate(booking.endDate)} · ${formatMoney(booking.grandTotal)}`, statusBadge(booking.status))).join('') : '<div class="empty">No rental bookings for this vehicle.</div>'}
        <h3 style="margin-top:20px">Ride offers from this vehicle (${(data.rides || []).length})</h3>
        ${(data.rides || []).length ? (data.rides || []).map(ride => row(`${ride.from} → ${ride.to}`, `${formatDate(ride.date)} ${ride.time || ''} · ${ride.seatsBooked}/${ride.seats} seats · ${formatMoney(ride.price)}/seat`, statusBadge(ride.status))).join('') : '<div class="empty">No ride offers for this vehicle.</div>'}
      </article>`;
      box.querySelector('#closeVehicleDetail')?.addEventListener('click', () => { state.activeVehicleId = null; box.innerHTML = ''; });
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { box.innerHTML = `<div class="rvx-empty"><p>${escapeHtml(error.message)}</p></div>`; }
  }

  function statusLabelShort(value) {
    return String(value || 'pending').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  }

  /* ----------------------------------------------------- owner summary */

  function renderOwners() {
    const box = document.getElementById('adminOwners');
    if (!box) return;
    const search = state.filters.ownerSearch.toLowerCase();
    let list = state.owners;
    if (search) list = list.filter(owner => [owner.name, owner.email, owner.phone].some(value => String(value || '').toLowerCase().includes(search)));
    if (state.filters.owner === 'approved') list = list.filter(owner => owner.approvedVehicles > 0);
    if (state.filters.owner === 'attention') list = list.filter(owner => owner.pendingVehicles > 0 || owner.pendingRides > 0 || owner.pendingBookings > 0);
    box.innerHTML = list.length ? list.map(owner => `
      <article class="owner-summary-row">
        <div class="rvx-user" style="min-width:0">
          ${imageOrInitials(owner.photo, owner.name, { className: 'rvx-user-avatar', alt: '' })}
          <span style="min-width:0"><strong>${escapeHtml(owner.name)}</strong><small>${escapeHtml(owner.email)}${owner.phone ? ` · ${escapeHtml(owner.phone)}` : ''}</small></span>
        </div>
        <div class="owner-metrics">
          <span><b>${owner.totalVehicles}</b> vehicles</span><span><b>${owner.approvedVehicles}</b> approved</span>
          <span><b>${owner.pendingVehicles}</b> pending</span><span><b>${owner.totalRides}</b> rides</span>
          <span><b>${owner.totalBookings}</b> rentals</span>
          <span><b>${owner.completedBookings}</b> completed</span><span><b>${owner.cancelledBookings}</b> cancelled</span>
          <span><b>${formatMoney(owner.totalEarnings)}</b> earnings</span>
        </div>
        <button class="btn btn-outline" type="button" data-owner-details="${escapeHtml(owner.id)}">Open owner summary</button>
      </article>`).join('') : '<div class="empty">No owner accounts found.</div>';
  }

  function renderOwnerDetail(data) {
    const box = document.getElementById('adminOwnerDetail');
    if (!box) return;
    if (!data) { box.innerHTML = ''; return; }
    const totals = data.totals || {};
    const revenue = data.revenue || {};
    const activity = data.activity || {};
    const verification = data.verification || {};
    const rides = data.rides || [];

    box.innerHTML = `<article class="detail-panel owner-detail-panel" style="margin-top:18px">
      <div class="panel-heading">
        <div class="rvx-user" style="min-width:0">
          ${imageOrInitials(data.owner.photo, data.owner.name, { className: 'rvx-user-avatar', alt: '' })}
          <span style="min-width:0"><span class="eyebrow">OWNER SUMMARY</span><h2 style="margin:0">${escapeHtml(data.owner.name)}</h2><small>${escapeHtml(data.owner.email)}${data.owner.phone ? ` · ${escapeHtml(data.owner.phone)}` : ''}</small></span>
        </div>
        <button class="btn btn-outline" id="closeOwnerDetail" type="button">Close</button>
      </div>

      <p class="card-meta">Joined ${escapeHtml(formatDate(data.owner.joinedAt))}${data.owner.lastLoginAt ? ` · Last login ${escapeHtml(formatDateTime(data.owner.lastLoginAt))}` : ''} · ${data.owner.active ? 'Active' : 'Deactivated'} · ★ ${Number(data.owner.rating || 5).toFixed(1)} (${data.owner.ratingCount || 0})</p>

      <h3 style="margin-top:20px">Summary</h3>
      <div class="rvx-stats">
        ${stat('Total vehicles', totals.totalVehicles || 0, `${totals.approvedVehicles || 0} approved`)}
        ${stat('Total rides', rides.length, `${rides.filter(r => r.status === 'pending').length} pending approval`)}
        ${stat('Rental bookings', totals.totalBookings || 0, `${totals.completedBookings || 0} completed`)}
        ${stat('Total revenue', formatMoney(revenue.total?.gross || 0), 'Paid, non-cancelled', 'accent')}
        ${stat('Cancellations', activity.cancellationCount || 0, `${formatMoney(revenue.total?.refunds || 0)} refunded`, activity.cancellationCount ? 'bad' : '')}
      </div>

      <h3 style="margin-top:20px">Vehicles <span class="muted-text">(${data.vehicles.length})</span></h3>
      ${data.vehicles.length ? `<div class="rvx-table-wrap"><table class="rvx-table"><thead><tr><th>Vehicle</th><th>Status</th><th class="num">Bookings</th><th class="num">Completed</th><th class="num">Owner income</th><th>Actions</th></tr></thead><tbody>
        ${data.vehicles.map(vehicle => `<tr>
          <td><div class="rvx-user">${imageOrInitials(vehicle.image, vehicle.name, { className: 'rvx-thumb rvx-thumb--xs', alt: '' })}<span class="rvx-user__name">${escapeHtml(vehicle.name)}</span></div><small>${escapeHtml(vehicle.numberPlate || 'No plate')}</small></td>
          <td>${statusBadge(vehicle.status)}</td>
          <td class="num">${vehicle.totalBookings || 0}</td>
          <td class="num">${vehicle.completedBookings || 0}</td>
          <td class="num">${formatMoney(vehicle.totalEarnings || 0)}</td>
          <td><div class="rvx-table__actions">
            <button class="btn btn-outline btn-small" data-open-vehicle="${escapeHtml(vehicle.id)}" type="button">Open</button>
            ${['pending', 'rejected', 'removed'].includes(vehicle.status) ? `<button class="btn btn-primary btn-small" data-verify="${escapeHtml(vehicle.id)}" data-decision="approve" type="button">Approve</button>` : ''}
            ${!['approved', 'rejected'].includes(vehicle.status) ? `<button class="btn btn-outline btn-small" data-verify="${escapeHtml(vehicle.id)}" data-decision="reject" type="button">Reject</button>` : ''}
            ${vehicle.status === 'approved' ? `<button class="btn btn-outline btn-small" data-vehicle-status="${escapeHtml(vehicle.id)}" data-next="removed" data-vehicle-name="${escapeHtml(vehicle.name || '')}" type="button">Remove</button>` : ''}
            ${vehicle.status !== 'removed' ? `<button class="btn btn-danger btn-small" data-remove-vehicle="${escapeHtml(vehicle.id)}" data-vehicle-name="${escapeHtml(vehicle.name || '')}" type="button">Delete</button>` : ''}
          </div></td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">This owner has not listed any vehicles.</div>'}

      <h3 style="margin-top:24px">Ride offers <span class="muted-text">(${rides.length})</span></h3>
      ${rides.length ? `<div class="rvx-table-wrap"><table class="rvx-table"><thead><tr><th>Ride</th><th>Vehicle</th><th>Date &amp; time</th><th class="num">Price / seat</th><th class="num">Seats</th><th class="num">Bookings</th><th class="num">Revenue</th><th>Status</th><th>Cancellation</th></tr></thead><tbody>
        ${rides.map(ride => `<tr>
          <td><b>ID ${escapeHtml(String(ride.id).slice(-8))}</b><br><small>${escapeHtml(ride.from)} → ${escapeHtml(ride.to)}</small></td>
          <td>${escapeHtml(ride.vehicle || '-')}<br><small>${escapeHtml(ride.numberPlate || '')}</small></td>
          <td>${escapeHtml(formatDate(ride.date))}<br><small>${escapeHtml(ride.time || '')}</small></td>
          <td class="num">${formatMoney(ride.price)}</td>
          <td class="num">${ride.seatsBooked || 0}/${ride.seats}</td>
          <td class="num">${ride.bookings || 0}</td>
          <td class="num">${formatMoney(ride.grossRevenue || 0)}<br><small>owner ${formatMoney(ride.ownerRevenue || 0)}</small></td>
          <td>${statusBadge(ride.status)}</td>
          <td><small>${ride.cancellationInfo?.cancelled || 0} cancelled${ride.cancellationInfo?.refundTotal ? ` · ${formatMoney(ride.cancellationInfo.refundTotal)} refunded` : ''}${ride.cancellationInfo?.lastReason ? `<br>${escapeHtml(ride.cancellationInfo.lastReason)}` : ''}</small></td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">This owner has not published any ride offers.</div>'}

      <h3 style="margin-top:24px">Revenue split</h3>
      <div class="rvx-stats">
        ${stat('Rental gross', formatMoney(revenue.rental?.gross || 0), `${revenue.rental?.bookings || 0} bookings`)}
        ${stat('Ride gross', formatMoney(revenue.ride?.gross || 0), `${revenue.ride?.bookings || 0} bookings`)}
        ${stat('Owner share', formatMoney(revenue.total?.ownerShare || 0), `${ownerSharePercent(revenue.ownerShareRate)}% of gross`, 'ok')}
        ${stat('Platform share', formatMoney(revenue.total?.platformShare || 0), `${100 - ownerSharePercent(revenue.ownerShareRate)}% to the platform`, 'accent')}
        ${stat('Refunds', formatMoney(revenue.total?.refunds || 0), 'Issued on cancellation', revenue.total?.refunds ? 'bad' : '')}
        ${stat('Net after refunds', formatMoney(revenue.total?.net || 0), '')}
      </div>
      ${(revenue.perVehicle || []).length ? `<h4 style="margin:16px 0 6px">Revenue per vehicle</h4>${revenue.perVehicle.map(item => row(item.vehicleName, `${item.bookings} booking(s)`, `<strong>${formatMoney(item.gross)}</strong>`)).join('')}` : ''}
      ${(revenue.perRide || []).length ? `<h4 style="margin:16px 0 6px">Revenue per ride</h4>${revenue.perRide.map(item => row(item.label, `ID ${String(item.rideId).slice(-8)}`, `<strong>${formatMoney(item.gross)}</strong>`)).join('')}` : ''}

      <h3 style="margin-top:24px">Activity</h3>
      <div class="rvx-stats">
        ${stat('Total vehicles', activity.totalVehicles || 0)}
        ${stat('Active vehicles', activity.activeVehicles || 0)}
        ${stat('Total rides', activity.totalRides || 0)}
        ${stat('Active rides', activity.activeRides || 0)}
        ${stat('Completed rides', activity.completedRides || 0)}
        ${stat('Cancelled rides', activity.cancelledRides || 0)}
        ${stat('Total rental bookings', activity.totalRentalBookings || 0)}
        ${stat('Completed rentals', activity.completedRentalBookings || 0)}
        ${stat('Cancellations', activity.cancellationCount || 0)}
        ${stat('User bookings', activity.userBookingCount || 0)}
        ${stat('Total revenue', formatMoney(activity.totalRevenue || 0), '', 'accent')}
      </div>

      <h3 style="margin-top:24px">Verification and documents</h3>
      <p class="card-meta">Owner approval: <b>${escapeHtml(verification.carApprovalStatus || 'pending')}</b> · ${verification.verifiedVehicles || 0} verified vehicle(s) · ${verification.pendingVehicles || 0} pending · ${verification.rejectedVehicles || 0} rejected</p>
      ${(verification.documents || []).length ? verification.documents.map(item => `<div style="margin-bottom:14px"><p class="card-meta"><b>${escapeHtml(item.vehicleName)}</b> (${escapeHtml(item.numberPlate || 'No plate')}) — ${statusBadge(item.status)}${item.rejectionReason ? ` · ${escapeHtml(item.rejectionReason)}` : ''}</p>${documents(item)}</div>`).join('') : '<div class="empty">No documents submitted.</div>'}

      <h3 style="margin-top:24px">Recent rental bookings</h3>
      ${(data.recentBookings || []).length ? (data.recentBookings || []).slice(0, 12).map(booking => row(booking.vehicleName || 'Vehicle', `${booking.userName} · ${formatDateTime(booking.createdAt)} · ${formatMoney(booking.grandTotal)}`, statusBadge(booking.status))).join('') : '<div class="empty">No rental bookings yet.</div>'}
    </article>`;

    box.querySelector('#closeOwnerDetail')?.addEventListener('click', () => { state.activeOwnerId = null; renderOwnerDetail(null); });
  }

  async function loadOwnerDetail(id) {
    const box = document.getElementById('adminOwnerDetail');
    if (box) box.innerHTML = '<div class="detail-panel" style="margin-top:18px"><div class="rvx-skeleton" style="height:220px"></div></div>';
    try {
      const data = await api(`/admin/owners/${encodeURIComponent(id)}`);
      state.activeOwnerId = id;
      state.ownerDetail = data;
      renderOwnerDetail(data);
      box?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { adminMessage(error.message, true); }
  }

  /* ----------------------------------------------------- ride approvals */

  function rideApprovalCard(ride) {
    const vehicle = ride.vehicleDetails || {};
    return `<article class="moderation-card" data-ride-row="${escapeHtml(ride.id)}"><div class="moderation-main">
      <div class="badge-row">${statusBadge(ride.status)}<span class="badge badge-category">${escapeHtml(ride.vehicleType || 'Other')}</span><span class="badge badge-fuel">${escapeHtml(ride.fuelType || 'Petrol')}</span></div>
      <div class="rvx-user" style="margin:10px 0">
        ${imageOrInitials(ride.vehicleImage || vehicle.image, ride.vehicle, { className: 'rvx-thumb rvx-thumb--sm', alt: '' })}
        <span style="min-width:0"><span class="rvx-user__name">${escapeHtml(ride.vehicle || 'Vehicle')}</span>
        <span class="rvx-user__sub">${escapeHtml(vehicle.numberPlate || ride.numberPlate || 'No plate')}${vehicle.name ? ` · linked to “${escapeHtml(vehicle.name)}”` : ''}</span></span>
      </div>
      <h3>${escapeHtml(ride.from)} → ${escapeHtml(ride.to)}</h3>
      <div class="request-facts">
        <span><b>Owner</b>${escapeHtml(ride.driverName || '-')} (${escapeHtml(ride.driverId).slice(-6)})</span>
        <span><b>Contact</b>${escapeHtml(ride.driverPhone || 'No phone')}</span>
        <span><b>Email</b>${escapeHtml(ride.driverEmail || '-')}</span>
        <span><b>Date</b>${escapeHtml(formatDate(ride.date))}</span>
        <span><b>Time</b>${escapeHtml(ride.time || '-')}</span>
        <span><b>Seats</b>${ride.seatsBooked || 0} / ${ride.seats} booked</span>
        <span><b>Price / seat</b>${formatMoney(ride.price)}</span>
        <span><b>Total for 1 seat</b>${formatMoney(ride.quote?.grandTotal ?? ride.price)}</span>
        ${Number(ride.distanceKm) > 0 ? `<span><b>Distance</b>${Number(ride.distanceKm).toLocaleString('en-IN')} km</span>` : ''}
        <span><b>Submitted</b>${escapeHtml(formatDateTime(ride.submittedAt))}</span>
      </div>
      ${ride.notes ? `<p class="card-meta">Notes: ${escapeHtml(ride.notes)}</p>` : ''}
      ${ride.pickupPoint ? `<p class="card-meta">Pickup point: ${escapeHtml(ride.pickupPoint)}</p>` : ''}
      ${ride.rejectionReason ? `<p class="status-error">Rejection reason: ${escapeHtml(ride.rejectionReason)}</p>` : ''}
      ${vehicle.documents?.length ? `<div class="document-section"><h4>Vehicle documents</h4>${documents(vehicle)}</div>` : ''}
    </div><div class="moderation-actions">
      ${ride.status === 'pending' || ride.status === 'rejected' ? `<button class="btn btn-primary" type="button" data-ride-verify="${escapeHtml(ride.id)}" data-decision="approve">Approve</button>
      <button class="btn btn-outline" type="button" data-ride-verify="${escapeHtml(ride.id)}" data-decision="reject">Reject</button>` : ''}
      ${ride.status === 'approved' ? `<button class="btn btn-danger" type="button" data-ride-remove="${escapeHtml(ride.id)}" data-ride-route="${escapeHtml(ride.from)} → ${escapeHtml(ride.to)}">Remove offer</button>` : ''}
    </div></article>`;
  }

  function renderRideApprovals() {
    const box = document.getElementById('adminRideApprovals');
    if (!box) return;
    const filter = state.filters.ride;
    const list = filter === 'all' ? state.rideApprovals : state.rideApprovals.filter(ride => ride.status === filter);
    box.innerHTML = list.length ? list.map(rideApprovalCard).join('') : '<div class="empty">No ride offers in this status.</div>';
  }

  /* ------------------------------------------------------------ bookings */

  function renderBookings() {
    const box = document.getElementById('adminBookings');
    if (!box) return;
    const filter = state.filters.booking;
    const list = filter === 'all' ? state.bookings : state.bookings.filter(booking => booking.status === filter);
    box.innerHTML = list.length ? list.map(booking => `
      <article class="booking-row" data-booking-row="${escapeHtml(booking.id)}">
        <div class="rvx-user" style="margin-bottom:8px">
          ${imageOrInitials(booking.vehicleImage, booking.vehicleName, { className: 'rvx-thumb rvx-thumb--xs', alt: '' })}
          <span style="min-width:0"><strong>${escapeHtml(booking.vehicleName || 'Vehicle')}</strong><small>${escapeHtml(booking.userName || 'Renter')} · ${escapeHtml(formatDateTime(booking.startDate))} → ${escapeHtml(formatDateTime(booking.endDate))}</small></span>
        </div>
        <div class="badge-row">${statusBadge(booking.status)}${statusBadge(booking.paymentStatus)}${booking.paymentMethod === 'demo' ? statusBadge('pending', 'test') : ''}</div>
        <p class="card-meta">Grand total ${formatMoney(booking.grandTotal)} · paid ${formatMoney(booking.paidAmount)} · vehicle ${escapeHtml(booking.vehicle?.numberPlate || 'no plate')}</p>
        ${booking.cancellation?.reason ? `<p class="status-error">${escapeHtml(booking.cancellation.reason)} · fee ${formatMoney(booking.cancellation.cancellationFee || 0)} · refund ${formatMoney(booking.cancellation.refundAmount || 0)}</p>` : ''}
        <div class="request-actions">
          ${booking.status === 'pending_owner' && booking.paymentStatus === 'paid' ? `<button class="btn btn-outline btn-small" data-booking-status="confirmed" data-booking-id="${escapeHtml(booking.id)}" type="button">Confirm</button>` : ''}
          ${['confirmed'].includes(booking.status) ? `<button class="btn btn-outline btn-small" data-booking-status="completed" data-booking-id="${escapeHtml(booking.id)}" type="button">Mark completed</button>` : ''}
          ${!['completed', 'rejected'].includes(booking.status) && !String(booking.status).startsWith('cancelled') ? `<button class="btn btn-danger btn-small" data-booking-cancel="${escapeHtml(booking.id)}" type="button">Cancel &amp; refund</button>` : ''}
          <a class="btn btn-outline btn-small" href="agreement.html?bookingId=${encodeURIComponent(booking.id)}">Open booking</a>
        </div>
      </article>`).join('') : '<div class="empty">No bookings found.</div>';
  }

  /* ------------------------------------------------------------ payments */

  function renderPayments() {
    const box = document.getElementById('adminPayments');
    if (!box) return;
    const filter = state.filters.payment;
    const list = state.payments.filter(payment => {
      if (filter === 'all') return true;
      if (filter === 'rental' || filter === 'ride') return payment.kind === filter;
      if (filter === 'demo') return payment.method === 'demo';
      if (filter === 'refunded') return payment.status === 'refunded' || payment.status === 'partially_refunded';
      return true;
    });
    const total = list.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const refunded = list.reduce((sum, payment) => sum + Number(payment.refundAmount || 0), 0);
    box.innerHTML = `<div class="rvx-stats">
        ${stat('Payments shown', list.length, filter === 'all' ? 'all records' : filter)}
        ${stat('Collected', formatMoney(total), '', 'accent')}
        ${stat('Refunded', formatMoney(refunded), '', refunded ? 'bad' : '')}
        ${stat('Test payments', list.filter(p => p.method === 'demo').length, 'No real money')}
      </div>` + (list.length ? `<div class="rvx-table-wrap"><table class="rvx-table"><thead><tr><th>Reference</th><th>Flow</th><th>Payee</th><th class="num">Amount</th><th class="num">Refunded</th><th>Method</th><th>Status</th><th>Date</th></tr></thead><tbody>
        ${list.map(payment => `<tr>
          <td><code>${escapeHtml(String(payment.reference || '').slice(-14))}</code></td>
          <td>${escapeHtml(payment.kind || 'rental')}</td>
          <td>${escapeHtml(payment.user?.name || '—')}${payment.owner?.name ? `<br><small>owner ${escapeHtml(payment.owner.name)}</small>` : ''}</td>
          <td class="num">${formatMoney(payment.amount)}</td>
          <td class="num">${formatMoney(payment.refundAmount)}</td>
          <td>${escapeHtml(payment.method)}</td>
          <td>${statusBadge(payment.status)}</td>
          <td><small>${escapeHtml(formatDateTime(payment.paidAt || payment.createdAt))}</small></td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No payments recorded yet.</div>');
  }

  /* -------------------------------------------------------------- income */

  function renderIncome() {
    const income = state.income;
    if (!income) return;
    // The API reports the OWNER's rate; the platform rate is its complement.
    const incomeOwnerRate = ownerSharePercent(income.ownerShareRate);
    document.getElementById('incomeCards').innerHTML = [
      statCard('Total revenue', formatMoney(income.totalRevenue), 'Paid rental + rides'),
      statCard('Rental revenue', formatMoney(income.rentalRevenue), `${income.rentalBookings} bookings`),
      statCard('Ride revenue', formatMoney(income.rideRevenue), `${income.rideBookings} bookings`),
      statCard('Platform share', formatMoney(income.platformEarnings ?? income.commission), `${100 - incomeOwnerRate}% service share`),
      statCard('Owner payout', formatMoney(income.ownerPayout), `${incomeOwnerRate}% owner share`),
      statCard('Completed bookings', income.completedBookings, 'Completed rentals'),
      statCard('Pending bookings', income.pendingBookings, 'Payment or owner review'),
      statCard('Cancelled bookings', income.cancelledBookings, 'Excluded from revenue')
    ].join('');
    document.getElementById('incomeByVehicle').innerHTML = income.revenueByVehicle?.length
      ? income.revenueByVehicle.map(item => row(item.vehicleName, `${item.ownerName} · ${item.bookings} booking(s) · owner ${formatMoney(item.ownerShare)}`, `<strong>${formatMoney(item.revenue)}</strong>`)).join('')
      : '<div class="empty">No paid vehicle revenue yet.</div>';
    document.getElementById('incomeByOwner').innerHTML = income.revenueByOwner?.length
      ? income.revenueByOwner.map(item => row(item.ownerName, `${item.bookings} booking(s) · owner ${formatMoney(item.ownerShare)}`, `<strong>${formatMoney(item.revenue)}</strong>`)).join('')
      : '<div class="empty">No owner revenue yet.</div>';
    const byBooking = document.getElementById('incomeByBooking');
    if (byBooking) {
      byBooking.innerHTML = income.revenueByBooking?.length
        ? income.revenueByBooking.map(item => row(item.vehicleName, `${item.renter} · ${formatDate(item.startDate)} → ${formatDate(item.endDate)} · owner ${formatMoney(item.ownerShare)}`, `<strong>${formatMoney(item.amount)}</strong>`)).join('')
        : '<div class="empty">No paid rental bookings yet.</div>';
    }
    document.getElementById('incomeRecent').innerHTML = income.recent?.length
      ? income.recent.map(item => row(item.vehicle, `${item.renter} · ${formatDateTime(item.date)} · ${escapeHtml(item.status)}`, `<strong>${formatMoney(item.amount)}</strong>`)).join('')
      : '<div class="empty">No transactions yet.</div>';
  }

  /* ---------------------------------------------------------- agreements */

  function renderAgreements() {
    const box = document.getElementById('adminAgreements');
    if (!box) return;
    const search = state.filters.agreementSearch.toLowerCase();
    const list = state.agreements.filter(item =>
      (state.filters.agreement === 'all' || item.agreementStatus === state.filters.agreement)
      && (!search || [item.agreementId, item.bookingId, item.renter?.name, item.owner?.name, item.vehicle?.name].some(value => String(value || '').toLowerCase().includes(search))));
    box.innerHTML = list.length ? list.map(item => `<article class="agreement-row"><div>
      <div class="badge-row"><span class="badge badge-muted">${escapeHtml(item.agreementId)}</span>${statusBadge(item.agreementStatus)}<span class="badge ${item.paymentStatus === 'PAID' ? 'badge-approved' : 'badge-pending'}">${escapeHtml(item.paymentStatus || 'PENDING')}</span></div>
      <h3>${escapeHtml(item.vehicle?.name || 'Vehicle')} · ${escapeHtml(item.renter?.name || 'Renter')}</h3>
      <p class="card-meta">Booking ${escapeHtml(item.bookingId)} · Owner: ${escapeHtml(item.owner?.name || '-')} · ${escapeHtml(item.vehicle?.numberPlate || 'No plate')}</p>
      <div class="request-facts">
        <span><b>Rental start</b>${escapeHtml(formatDateTime(item.booking?.startDate || item.pickupDate))}</span>
        <span><b>Return</b>${escapeHtml(formatDateTime(item.booking?.endDate || item.returnDate))}</span>
        <span><b>Rental amount</b>${formatMoney(item.baseAmount ?? item.rentalAmount ?? 0)}</span>
        <span><b>Extra charges</b>${formatMoney(item.extraKilometerCharges || 0)}</span>
        <span><b>Tax / fees</b>${formatMoney(item.taxFees || 0)}</span>
        <span><b>Grand total</b>${formatMoney(item.grandTotal || item.rentalAmount || 0)}</span>
        <span><b>Paid</b>${formatMoney(item.booking?.paidAmount || 0)}</span>
        <span><b>Remaining</b>${formatMoney(item.booking?.remainingAmount || 0)}</span>
        <span><b>Acceptance</b>${item.acceptedByUser ? 'Renter ' : ''}${item.acceptedByOwner ? 'Owner' : ''}${(!item.acceptedByUser && !item.acceptedByOwner) ? 'Pending' : ''}</span>
      </div></div><div class="request-actions">
      <a class="btn btn-outline btn-small" href="agreement.html?bookingId=${encodeURIComponent(item.bookingId)}" target="_blank" rel="noopener">View</a>
      <button class="btn btn-outline btn-small" data-download-agreement="${escapeHtml(item.bookingId)}" type="button">PDF</button>
    </div></article>`).join('') : '<div class="empty">No agreements match.</div>';

    const missing = document.getElementById('adminMissingAgreements');
    if (missing) {
      missing.innerHTML = state.missingAgreements.length
        ? `<div class="detail-panel" style="margin-top:18px"><h3>Bookings without an agreement (${state.missingAgreements.length})</h3>${state.missingAgreements.slice(0, 20).map(item => row(`Booking ${String(item.id).slice(-8)}`, `${formatDateTime(item.createdAt)} · ${escapeHtml(item.status)}`, statusBadge('pending', 'no agreement'))).join('')}</div>`
        : '';
    }
  }

  /* --------------------------------------------------------------- users */

  function renderUsers() {
    const box = document.getElementById('adminUsers');
    if (!box) return;
    const me = getStoredUser();
    const filter = state.filters.user;
    const groups = [['Admins', 'admin'], ['Owners', 'owner'], ['Riders', 'user']]
      .filter(([, role]) => filter === 'all' || filter === role);
    box.innerHTML = groups.map(([label, role]) => {
      const users = state.users.filter(user => user.role === role);
      return `<h3>${label} (${users.length})</h3>${users.map(user => `<div class="user-admin-row">
        <div class="rvx-user" style="min-width:0">
          ${imageOrInitials(user.photo, user.name, { className: 'rvx-user-avatar', alt: '' })}
          <span style="min-width:0"><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}${user.phone ? ` · ${escapeHtml(user.phone)}` : ''} · ${user.active === false ? 'Deactivated' : 'Active'}${user.photo ? '' : ' · no profile photo'}</small></span>
        </div>
        ${user.id !== me?.id ? `<button class="btn btn-danger btn-small" data-delete-user="${escapeHtml(user.id)}" data-user-name="${escapeHtml(user.name)}" data-user-role="${escapeHtml(role)}" type="button">Delete</button>` : '<span class="muted-text">You</span>'}
      </div>`).join('') || '<div class="empty">No accounts.</div>'}`;
    }).join('');
  }

  function renderAdminProfile() {
    const box = document.getElementById('adminProfile');
    if (!box || !state.profile) return;
    const user = state.profile;
    box.innerHTML = `<div class="rvx-user" style="margin-bottom:12px">${imageOrInitials(user.photo, user.name, { className: 'rvx-user-avatar', alt: '' })}<span class="rvx-user__name">${escapeHtml(user.name)}</span></div>
      <p><b>Name:</b> ${escapeHtml(user.name)}</p><p><b>Email:</b> ${escapeHtml(user.email)}</p>
      <p><b>Phone:</b> ${escapeHtml(user.phone || '-')}</p><p><b>Role:</b> Admin</p>
      <a class="btn btn-outline" href="profile.html">Edit profile</a>`;
  }

  /* ---------------------------------------------------------------- data */

  async function loadData() {
    const results = await Promise.allSettled([
      api('/admin/summary'),
      api('/admin/vehicles?status=all'),
      api('/admin/owners'),
      api('/admin/bookings'),
      api('/admin/ride-approvals?status=all'),
      api('/admin/income'),
      api('/admin/users'),
      api('/auth/me'),
      api('/admin/agreements'),
      api('/payments?limit=200')
    ]);
    const value = index => (results[index].status === 'fulfilled' ? results[index].value : null);
    const list = index => { const data = value(index); return Array.isArray(data) ? data : (Array.isArray(data?.payments) ? data.payments : []); };

    state.summary = value(0);
    state.vehicles = list(1);
    state.owners = list(2);
    state.bookings = list(3);
    state.rideApprovals = list(4);
    state.income = value(5);
    state.users = list(6);
    state.profile = value(7)?.user || null;
    state.agreements = list(8).length ? list(8) : (value(8)?.agreements || []);
    state.missingAgreements = value(8)?.missingBookings || [];
    state.payments = list(9);

    renderStats(); renderApprovalSummary(); renderActivity(); renderVehicles();
    renderOwners(); renderRideApprovals(); renderBookings();
    renderPayments(); renderAgreements(); renderIncome(); renderUsers(); renderAdminProfile();

    const failed = results.findIndex(result => result.status === 'rejected');
    if (failed >= 0) adminMessage(results[failed].reason?.message || 'Some admin data could not be loaded.', true);
  }

  function showTab(tab, options = {}) {
    if (!tab || tab === 'rideBookings' || !document.getElementById(`panel-${tab}`)) tab = 'dashboard';
    state.activeTab = tab;
    document.querySelectorAll('.admin-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    document.querySelectorAll('.admin-panel').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${tab}`));
    try { sessionStorage.setItem('revexAdminTab', tab); } catch { /* private mode */ }

    // Keep the active Admin function in the URL so refresh, browser Back/Forward
    // and direct links behave like the User/Owner mobile navigation.
    if (options.history) {
      const url = new URL(location.href);
      url.searchParams.set('tab', tab);
      url.searchParams.delete('bookingId');
      const method = options.history === 'replace' ? 'replaceState' : 'pushState';
      if (`${url.pathname}${url.search}${url.hash}` !== `${location.pathname}${location.search}${location.hash}`) {
        history[method]({ revexAdminTab: tab }, '', `${url.pathname}${url.search}${url.hash}`);
      }
    }
  }

  /* ------------------------------------------------------------- actions */

  async function moderateVehicle(button) {
    const decision = button.dataset.decision;
    if (decision === 'reject') {
      const answer = await confirmAction({
        title: 'Reject this vehicle?',
        message: 'The owner sees the reason and can correct the documents and resubmit.',
        confirmLabel: 'Reject vehicle', tone: 'danger',
        reasonLabel: 'Rejection reason (the owner sees this)', reasonRequired: true
      });
      if (!answer) return;
      busy(button);
      try {
        const result = await api(`/admin/vehicles/${encodeURIComponent(button.dataset.verify)}/verify`, { method: 'PATCH', body: { decision, reason: answer.reason } });
        adminMessage(result.message); showToast(result.message, 'ok');
        await loadData();
        if (state.activeOwnerId) await loadOwnerDetail(state.activeOwnerId);
      } catch (error) { adminMessage(error.message, true); showToast(error.message, 'bad'); busy(button, false); }
      return;
    }
    const answer = await confirmAction({ title: 'Approve this vehicle?', message: 'It becomes bookable on the renter portal immediately.', confirmLabel: 'Approve vehicle' });
    if (!answer) return;
    busy(button);
    try {
      const result = await api(`/admin/vehicles/${encodeURIComponent(button.dataset.verify)}/verify`, { method: 'PATCH', body: { decision } });
      adminMessage(result.message); showToast(result.message, 'ok');
      await loadData();
      if (state.activeOwnerId) await loadOwnerDetail(state.activeOwnerId);
    } catch (error) { adminMessage(error.message, true); showToast(error.message, 'bad'); busy(button, false); }
  }

  /** Removes a vehicle from the marketplace without deleting any record. */
  async function setVehicleStatus(button) {
    const next = button.dataset.next || 'removed';
    const name = button.dataset.vehicleName || 'this vehicle';
    const answer = await confirmAction({
      title: `Mark "${name}" as ${next}?`,
      message: 'The vehicle record and all of its bookings are kept. It disappears from the renter portal and from Find a Ride.',
      confirmLabel: next === 'removed' ? 'Remove vehicle' : 'Update vehicle', tone: next === 'removed' ? 'danger' : 'primary',
      reasonLabel: 'Reason (the owner sees this)', reasonRequired: next === 'removed'
    });
    if (!answer) return;
    busy(button);
    try {
      const result = await api(`/admin/vehicles/${encodeURIComponent(button.dataset.vehicleStatus)}/status`, { method: 'PATCH', body: { status: next, reason: answer.reason } });
      adminMessage(result.message); showToast(result.message, 'ok');
      await loadData();
      if (state.activeOwnerId) await loadOwnerDetail(state.activeOwnerId);
    } catch (error) { adminMessage(error.message, true); showToast(error.message, 'bad'); busy(button, false); }
  }

  async function removeVehicle(button) {
    const name = button.dataset.vehicleName || 'this vehicle';
    const confirmDelete = global.confirmDelete;
    if (typeof confirmDelete !== 'function') { showToast('The delete confirmation helper did not load.', 'bad'); return; }
    const ok = await confirmDelete({
      title: 'Delete vehicle permanently',
      lead: `${name} will be removed from MongoDB and will no longer appear anywhere in REVEX.`,
      impact: [
        'The vehicle document and its uploaded documents are deleted',
        'Every booking, agreement, payment and review for this vehicle is deleted',
        'The number plate becomes available for registration again'
      ],
      warning: 'This cannot be undone. To take a vehicle off the market without losing history, use "Remove" instead.',
      confirmLabel: 'Delete vehicle',
      onConfirm: async reason => {
        const result = await api(`/admin/vehicles/${encodeURIComponent(button.dataset.removeVehicle)}`, { method: 'DELETE', body: { reason, confirm: true } });
        adminMessage(result.message);
        await loadData();
        if (state.activeOwnerId) await loadOwnerDetail(state.activeOwnerId);
        return true;
      }
    });
    if (!ok) adminMessage('Deletion cancelled.');
  }

  async function verifyRide(button) {
    const decision = button.dataset.decision || 'approve';
    if (decision === 'reject') {
      const answer = await confirmAction({
        title: 'Reject this ride offer?', message: 'The owner sees the reason and can submit a corrected offer.',
        confirmLabel: 'Reject offer', tone: 'danger',
        reasonLabel: 'Rejection reason (the owner sees this)', reasonRequired: true
      });
      if (!answer) return;
      busy(button);
      try {
        const result = await api(`/admin/rides/${encodeURIComponent(button.dataset.rideVerify)}/verify`, { method: 'PATCH', body: { decision, reason: answer.reason } });
        adminMessage(result.message || 'Ride rejected.'); showToast(result.message || 'Ride rejected.', 'ok');
        await loadData();
      } catch (error) { adminMessage(error.message, true); showToast(error.message, 'bad'); busy(button, false); }
      return;
    }
    const answer = await confirmAction({ title: 'Approve this ride offer?', message: 'It becomes visible and bookable on Find a Ride immediately.', confirmLabel: 'Approve offer' });
    if (!answer) return;
    busy(button);
    try {
      const result = await api(`/admin/rides/${encodeURIComponent(button.dataset.rideVerify)}/verify`, { method: 'PATCH', body: { decision } });
      adminMessage(result.message || 'Ride approved.'); showToast(result.message || 'Ride approved.', 'ok');
      await loadData();
    } catch (error) { adminMessage(error.message, true); showToast(error.message, 'bad'); busy(button, false); }
  }

  /** Removing a ride offer refunds every paid seat and releases unpaid holds. */
  async function removeRide(button) {
    const route = button.dataset.rideRoute || 'this ride';
    const answer = await confirmAction({
      title: `Remove the ${route} offer?`,
      message: 'Unpaid seat holds are released. Every PAID seat is refunded under the REVEX cancellation policy, and both the rider and the owner are notified. Records are kept.',
      confirmLabel: 'Remove and refund', tone: 'danger',
      reasonLabel: 'Reason (riders and the owner see this)', reasonRequired: true
    });
    if (!answer) return;
    busy(button);
    try {
      const result = await api(`/admin/rides/${encodeURIComponent(button.dataset.rideRemove)}`, { method: 'DELETE', body: { reason: answer.reason, refundPaid: true } });
      adminMessage(result.message); showToast(result.message, 'ok', 9000);
      (result.results || []).filter(row => row.reason).forEach(row => showToast(`Refund issue: ${row.reason}`, 'bad', 12000));
      await loadData();
    } catch (error) { adminMessage(error.message, true); showToast(error.message, 'bad'); busy(button, false); }
  }

  async function updateBookingStatus(button) {
    const next = button.dataset.bookingStatus;
    const answer = await confirmAction({ title: `Mark this booking ${next}?`, message: 'The renter is notified.', confirmLabel: `Mark ${next}` });
    if (!answer) return;
    busy(button);
    try {
      const result = await api(`/admin/bookings/${encodeURIComponent(button.dataset.bookingId)}/status`, { method: 'PATCH', body: { status: next } });
      adminMessage(result.message || 'Booking updated.'); showToast(result.message || 'Booking updated.', 'ok');
      await loadData();
    } catch (error) { adminMessage(error.message, true); showToast(error.message, 'bad'); busy(button, false); }
  }

  async function cancelBooking(button) {
    const answer = await confirmAction({
      title: 'Cancel this booking?',
      message: 'The cancellation policy runs: a cancellation inside the free window is refunded in full, otherwise the policy fee is kept. A real refund is requested through Razorpay when one is attached. The record is never deleted.',
      confirmLabel: 'Cancel and refund', tone: 'danger',
      reasonLabel: 'Cancellation reason (the renter sees this)', reasonRequired: true
    });
    if (!answer) return;
    busy(button);
    try {
      const result = await api(`/admin/bookings/${encodeURIComponent(button.dataset.bookingCancel)}/status`, { method: 'PATCH', body: { status: 'cancelled', reason: answer.reason } });
      adminMessage(result.message); showToast(result.message, 'ok', 9000);
      if (result.refund?.gatewayError) showToast(`Automatic refund failed: ${result.refund.gatewayError}`, 'bad', 12000);
      await loadData();
    } catch (error) { adminMessage(error.message, true); showToast(error.message, 'bad'); busy(button, false); }
  }


  async function deleteUserAccount(button) {
    const name = button.dataset.userName || 'this account';
    const role = button.dataset.userRole || 'user';
    const confirmDelete = global.confirmDelete;
    if (typeof confirmDelete !== 'function') { showToast('The delete confirmation helper did not load.', 'bad'); return; }
    const ok = await confirmDelete({
      title: 'Delete account permanently',
      lead: `${name} will be removed from MongoDB along with everything they created.`,
      impact: [
        'The user account is deleted and can no longer log in',
        `All vehicles listed by this ${role} are deleted with their bookings`,
        'Their bookings, agreements, payments, reviews and notifications are deleted',
        'Their ride offers and seat bookings are deleted'
      ],
      warning: 'This cannot be undone. The person will have to register again from scratch.',
      confirmLabel: 'Delete account',
      onConfirm: async reason => {
        const result = await api(`/admin/users/${encodeURIComponent(button.dataset.deleteUser)}`, { method: 'DELETE', body: { reason, confirm: true } });
        adminMessage(result.message);
        await loadData();
        return true;
      }
    });
    if (!ok) adminMessage('Deletion cancelled.');
  }

  /* ----------------------------------------------------------- chat tab */

  let chatMounted = false;
  async function mountAdminChat() {
    if (chatMounted || !global.RevexChat) return;
    const host = document.getElementById('adminChatHost');
    if (!host) return;
    chatMounted = true;
    host.innerHTML = '';
    const panel = global.RevexChat.mount({ launcher: false, host });
    if (!panel) { host.innerHTML = '<div class="rvx-empty"><p>Sign in again to use the assistant.</p></div>'; chatMounted = false; return; }
    const status = await global.RevexChat.checkStatus();
    if (status.message) global.RevexChat.setStatus(status.message);
    global.RevexChat.addMessage('assistant', 'Admin assistant ready. Ask about approvals, refunds, owner summaries or the reporting numbers.', new Date());
  }

  /* ----------------------------------------------------------------- boot */

  document.addEventListener('DOMContentLoaded', async () => {
    if (getStoredUser()?.role !== 'admin') return;
    document.querySelectorAll('[data-exit-admin]').forEach((button) => button.addEventListener('click', () => { clearSession(); location.href = 'index.html'; }));
    document.querySelector('.admin-tabs')?.addEventListener('click', event => {
      const button = event.target.closest('[data-tab]');
      if (button) {
        event.preventDefault();
        showTab(button.dataset.tab, { history: 'push' });
        const tabs = document.querySelector('.admin-tabs');
        const menu = document.querySelector('.admin-menu');
        tabs?.classList.remove('open');
        menu?.setAttribute('aria-expanded', 'false');
      }
    });

    document.body.addEventListener('click', async event => {
      const go = event.target.closest('[data-go-tab]');
      if (go) {
        if (go.dataset.statusFilter) { state.filters.vehicle = go.dataset.statusFilter; document.querySelectorAll('[data-vehicle-filter]').forEach(chip => chip.classList.toggle('active', chip.dataset.vehicleFilter === state.filters.vehicle)); renderVehicles(); }
        showTab(go.dataset.goTab);
        return;
      }
      const refresh = event.target.closest('[data-refresh]');
      if (refresh) { await loadData(); return; }

      const vehicleFilter = event.target.closest('[data-vehicle-filter]');
      if (vehicleFilter) { state.filters.vehicle = vehicleFilter.dataset.vehicleFilter; document.querySelectorAll('[data-vehicle-filter]').forEach(chip => chip.classList.toggle('active', chip === vehicleFilter)); renderVehicles(); return; }
      const ownerFilter = event.target.closest('[data-owner-filter]');
      if (ownerFilter) { state.filters.owner = ownerFilter.dataset.ownerFilter; document.querySelectorAll('[data-owner-filter]').forEach(chip => chip.classList.toggle('active', chip === ownerFilter)); renderOwners(); return; }
      const bookingFilter = event.target.closest('[data-booking-filter]');
      if (bookingFilter) { state.filters.booking = bookingFilter.dataset.bookingFilter; document.querySelectorAll('[data-booking-filter]').forEach(chip => chip.classList.toggle('active', chip === bookingFilter)); renderBookings(); return; }
      const rideFilter = event.target.closest('[data-ride-filter]');
      if (rideFilter) { state.filters.ride = rideFilter.dataset.rideFilter; document.querySelectorAll('[data-ride-filter]').forEach(chip => chip.classList.toggle('active', chip === rideFilter)); renderRideApprovals(); return; }
      const paymentFilter = event.target.closest('[data-payment-filter]');
      if (paymentFilter) { state.filters.payment = paymentFilter.dataset.paymentFilter; document.querySelectorAll('[data-payment-filter]').forEach(chip => chip.classList.toggle('active', chip === paymentFilter)); renderPayments(); return; }
      const userFilter = event.target.closest('[data-user-filter]');
      if (userFilter) { state.filters.user = userFilter.dataset.userFilter; document.querySelectorAll('[data-user-filter]').forEach(chip => chip.classList.toggle('active', chip === userFilter)); renderUsers(); return; }

      const verify = event.target.closest('[data-verify]');
      if (verify) return moderateVehicle(verify);
      const vehicleStatus = event.target.closest('[data-vehicle-status]');
      if (vehicleStatus) return setVehicleStatus(vehicleStatus);
      const remove = event.target.closest('[data-remove-vehicle]');
      if (remove) return removeVehicle(remove);
      const openVehicleButton = event.target.closest('[data-open-vehicle]');
      if (openVehicleButton) return openVehicle(openVehicleButton.dataset.openVehicle);
      const owner = event.target.closest('[data-owner-details]');
      if (owner) return loadOwnerDetail(owner.dataset.ownerDetails);
      const booking = event.target.closest('[data-booking-status]');
      if (booking) return updateBookingStatus(booking);
      const bookingCancel = event.target.closest('[data-booking-cancel]');
      if (bookingCancel) return cancelBooking(bookingCancel);
      const ride = event.target.closest('[data-ride-verify]');
      if (ride) return verifyRide(ride);
      const rideRemove = event.target.closest('[data-ride-remove]');
      if (rideRemove) return removeRide(rideRemove);
      const user = event.target.closest('[data-delete-user]');
      if (user) return deleteUserAccount(user);
      const agreementDownload = event.target.closest('[data-download-agreement]');
      if (agreementDownload) return global.downloadAgreement(agreementDownload.dataset.downloadAgreement);
    });

    document.getElementById('refreshAdmin')?.addEventListener('click', loadData);
    document.getElementById('ownerSearch')?.addEventListener('input', event => { state.filters.ownerSearch = event.target.value.trim(); renderOwners(); });
    document.querySelectorAll('[data-agreement-filter]').forEach(chip => chip.addEventListener('click', () => {
      document.querySelectorAll('[data-agreement-filter]').forEach(item => item.classList.remove('active'));
      chip.classList.add('active');
      state.filters.agreement = chip.dataset.agreementFilter;
      renderAgreements();
    }));
    document.getElementById('agreementSearch')?.addEventListener('input', event => { state.filters.agreementSearch = event.target.value.trim(); renderAgreements(); });
    document.getElementById('addAdminForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      const message = document.getElementById('addAdminMsg');
      try {
        const result = await api('/admin/create-admin', {
          method: 'POST',
          body: {
            name: form.name.value.trim(), email: form.email.value.trim(), phone: form.phone.value.trim(),
            password: form.password.value, confirmPassword: form.confirmPassword.value
          }
        });
        message.textContent = result.message; message.className = 'form-message'; form.reset();
        await loadData();
      } catch (error) { message.textContent = error.message; message.className = 'form-message form-message-error'; }
    });

    const pageParams = new URLSearchParams(location.search);
    const requestedTabRaw = pageParams.get('tab');
    const requestedTab = requestedTabRaw === 'rideBookings' ? 'dashboard' : requestedTabRaw;
    try { if (sessionStorage.getItem('revexAdminTab') === 'rideBookings') sessionStorage.removeItem('revexAdminTab'); } catch { /* private mode */ }
    try {
      const saved = sessionStorage.getItem('revexAdminTab');
      if (requestedTab && document.getElementById(`panel-${requestedTab}`)) showTab(requestedTab);
      else if (saved && document.getElementById(`panel-${saved}`)) showTab(saved);
      else showTab('dashboard');
    } catch {
      if (requestedTab && document.getElementById(`panel-${requestedTab}`)) showTab(requestedTab);
      else showTab('dashboard');
    }
    window.addEventListener('popstate', () => {
      const raw = new URLSearchParams(location.search).get('tab');
      const tab = raw === 'rideBookings' ? 'dashboard' : raw;
      showTab(tab && document.getElementById(`panel-${tab}`) ? tab : 'dashboard');
    });

    const focusBooking = pageParams.get('bookingId');
    if (focusBooking) showTab('bookings');

    await loadData();

    if (focusBooking) {
      const target = document.querySelector(`[data-booking-row="${CSS.escape(focusBooking)}"]`);
      if (target) { target.classList.add('is-highlighted'); target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      else adminMessage(`Booking ${focusBooking} was not found in the current list.`);
    }
  });

  global.RevexAdmin = { state, loadData, showTab, renderOwnerDetail };
})(window);

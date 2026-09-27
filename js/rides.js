/* ============================================================================
 * RIDE SHARING  (js/rides.js)
 *
 * Three screens in one file, because they share one data shape:
 *   1. find-ride.html   - the public ride list
 *   2. ride-details.html- one ride, seat selection, "Pay & Book Ride"
 *   3. offer-ride.html  - the owner publishes a ride offer
 *
 * What changed in 1.3 and why:
 *   - The offer form used to require a SECOND photo upload, which is how Find
 *     Ride ended up showing a different image from Rent Vehicle for the same
 *     car. It now picks one of the owner's registered vehicles and reuses that
 *     vehicle's photo, and only offers a manual upload for owners with none.
 *   - The seat total was recomputed in the browser from a hidden price input.
 *     It is now the backend's quote, so the card, the payment panel, the
 *     Razorpay order and the stored booking all show the same number.
 *   - "Review and pay" is now "Pay & Book Ride", and the payment is a real
 *     Razorpay checkout (or a clearly labelled test payment when no keys are
 *     configured) instead of an instant local success message.
 * ========================================================================== */
(function (global) {
  'use strict';

  const R = global.REVEX;
  if (!R) return;
  const { api, escapeHtml, formatMoney, formatDate, assetUrl, showToast, showModal, requireLogin, requireRole, statusBadge, imageOrInitials } = R;

  let currentRideId = '';
  let currentRide = null;
  let currentQuote = null;

  /* ------------------------------------------------------------ helpers */

  function readFileAsDataUrl(file, maxMb = 3) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve('');
      if (file.size > maxMb * 1024 * 1024) return reject(new Error(`The photo must be smaller than ${maxMb} MB.`));
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('The selected photo could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  async function getRides(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => { if (value) query.set(key, value); });
    const suffix = query.toString();
    return api(`/rides${suffix ? `?${suffix}` : ''}`);
  }

  function seatsText(ride) {
    const left = Number(ride.seatsAvailable ?? ride.seats ?? 0);
    if (ride.soldOut || left <= 0) return 'Sold out';
    return left === 1 ? '1 seat left' : `${left} seats left`;
  }

  /* ------------------------------------------------- 1. FIND A RIDE (list) */

  function rideCard(ride) {
    const quote = ride.quote || {};
    const total = Number(quote.grandTotal ?? ride.price ?? 0);
    const bookable = ride.bookable && !ride.soldOut;
    return `
      <article class="rvx-card rvx-card--link rvx-card--flush" data-ride="${escapeHtml(ride.id)}">
        ${imageOrInitials(ride.vehicleImage, ride.vehicle, { className: 'rvx-thumb', alt: `${ride.vehicle || 'Vehicle'} on this ride` })}
        <div style="padding:16px 18px 18px;display:grid;gap:12px">
          <div class="rvx-card__head">
            <div style="min-width:0">
              <h3 class="rvx-card__title">${escapeHtml(ride.from)} &rarr; ${escapeHtml(ride.to)}</h3>
              <p class="rvx-card__meta">${escapeHtml(ride.vehicle || 'Vehicle')}${ride.numberPlate ? ` · ${escapeHtml(ride.numberPlate)}` : ''}</p>
            </div>
            ${statusBadge(ride.status)}
          </div>

          <div class="rvx-chips">
            <span class="rvx-chip">${escapeHtml(formatDate(ride.date))} · ${escapeHtml(ride.time || '')}</span>
            <span class="rvx-chip">${escapeHtml(seatsText(ride))}</span>
            <span class="rvx-chip">${escapeHtml(ride.fuelType || 'Petrol')}</span>
            ${Number(ride.distanceKm) > 0 ? `<span class="rvx-chip">${Number(ride.distanceKm).toLocaleString('en-IN')} km</span>` : ''}
          </div>

          <div class="rvx-user">
            ${imageOrInitials(ride.driverPhoto, ride.driver, { className: 'rvx-user-avatar', alt: '' })}
            <span style="min-width:0">
              <span class="rvx-user__name">${escapeHtml(ride.driver || 'REVEX driver')}</span>
              <span class="rvx-user__sub">★ ${Number(ride.rating || 5).toFixed(1)} · ${escapeHtml(ride.vehicleType || 'Car')}</span>
            </span>
          </div>

          <div class="rvx-price rvx-price--total">
            <span class="rvx-price__amount">${formatMoney(total)}</span>
            <span class="rvx-price__unit">total for 1 seat</span>
            <span class="rvx-price__unit" style="margin-left:auto">${formatMoney(ride.price)} per seat</span>
          </div>

          <div class="rvx-card__actions">
            <a class="rvx-btn rvx-btn--ghost rvx-btn--sm" href="ride-details.html?id=${encodeURIComponent(ride.id)}">Details</a>
            ${bookable
              ? `<a class="rvx-btn rvx-btn--primary rvx-btn--sm" href="ride-details.html?id=${encodeURIComponent(ride.id)}#book">Pay &amp; Book Ride</a>`
              : `<button type="button" class="rvx-btn rvx-btn--ghost rvx-btn--sm" disabled aria-disabled="true">${ride.soldOut ? 'Sold out' : 'Not bookable'}</button>`}
          </div>
        </div>
      </article>`;
  }

  async function renderRides(rides, box) {
    if (!box) return;
    box.innerHTML = rides?.length
      ? rides.map(rideCard).join('')
      : `<div class="rvx-empty"><h3>No matching rides</h3><p>Approved ride offers appear here as soon as an owner publishes one. Try widening your search.</p></div>`;
  }

  /* ------------------------------------------ 2. RIDE DETAIL + BOOK + PAY */

  function quoteLines(quote) {
    if (!quote) return '';
    const rows = [
      [`${quote.seats} seat(s) × ${formatMoney(quote.price)}`, formatMoney(quote.baseRideAmount)],
      quote.additionalCharges > 0 ? ['Extras (tolls, pickup)', formatMoney(quote.additionalCharges)] : null,
      [`Platform fee (${quote.platformFeePercent}%)`, formatMoney(quote.platformFee)],
      quote.discountPercent > 0 ? [`Discount (${quote.discountPercent}%)`, `− ${formatMoney(quote.discountAmount)}`] : null
    ].filter(Boolean);
    return rows.map(([label, value]) => `<div class="rvx-line"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  }

  function renderQuote(quote) {
    const box = document.getElementById('rideQuote');
    if (!box) return;
    box.innerHTML = `
      <dl class="rvx-lines">
        ${quoteLines(quote)}
        <div class="rvx-line rvx-line--total"><dt>Total payable</dt><dd>${formatMoney(quote.grandTotal)}</dd></div>
      </dl>
      <p class="rvx-card__meta" style="margin-top:8px">${escapeHtml(quote.formula || '')}</p>`;
    const amount = document.getElementById('ridePayAmount');
    if (amount) amount.textContent = formatMoney(quote.grandTotal);
    const total = document.getElementById('seatTotal');
    if (total) total.textContent = formatMoney(quote.grandTotal);
  }

  function paymentDialog({ quote, ride, config, onDismiss }) {
    const overlay = document.createElement('div');
    overlay.className = 'rvx-modal';
    overlay.innerHTML = `
      <div class="rvx-modal__card" role="dialog" aria-modal="true" aria-labelledby="rvxPayTitle">
        <h2 id="rvxPayTitle">Pay &amp; Book Ride</h2>
        <div class="rvx-user">
          ${imageOrInitials(ride.vehicleImage, ride.vehicle, { className: 'rvx-thumb rvx-thumb--sm', alt: '' })}
          <span style="min-width:0">
            <span class="rvx-user__name">${escapeHtml(ride.from)} &rarr; ${escapeHtml(ride.to)}</span>
            <span class="rvx-user__sub">${escapeHtml(formatDate(ride.date))} · ${escapeHtml(ride.time || '')} · ${escapeHtml(ride.vehicle || '')}</span>
          </span>
        </div>
        <dl class="rvx-lines">
          ${quoteLines(quote)}
          <div class="rvx-line rvx-line--total"><dt>Amount payable now</dt><dd id="ridePayAmount">${formatMoney(quote.grandTotal)}</dd></div>
        </dl>
        <p class="rvx-notice rvx-notice--${config.usable ? 'info' : 'warn'}">
          ${config.usable
            ? '<div><strong>Razorpay checkout.</strong> Your seat is confirmed only after the server verifies the payment signature.</div>'
            : `<div><strong>Test payment.</strong> ${escapeHtml(config.testModeLabel || 'No working payment gateway is configured on this server')}, so a labelled test payment is recorded instead. No real money moves.</div>`}
        </p>
        <div class="rvx-modal__actions">
          <button type="button" class="rvx-btn rvx-btn--ghost" data-cancel>Cancel</button>
          <button type="button" class="rvx-btn rvx-btn--primary" data-pay>${config.usable ? `Pay ${formatMoney(quote.grandTotal)}` : `Record test payment · ${formatMoney(quote.grandTotal)}`}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => { overlay.remove(); onDismiss?.(); };
    const pay = overlay.querySelector('[data-pay]');
    overlay.querySelector('[data-cancel]').addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    pay.focus();
    return { overlay, pay, close };
  }

  async function refreshQuote() {
    if (!currentRideId) return null;
    const seats = Number(document.getElementById('seatCount')?.value) || 1;
    currentQuote = await api(`/rides/${encodeURIComponent(currentRideId)}/quote?seats=${seats}`);
    renderQuote(currentQuote);
    const hint = document.getElementById('rideAvailability');
    if (hint) {
      hint.textContent = currentQuote.bookable
        ? `${currentQuote.seatsAvailable} seat(s) available right now.`
        : currentQuote.seatsAvailable > 0
          ? `Only ${currentQuote.seatsAvailable} seat(s) are left.`
          : 'All seats on this ride have been booked.';
    }
    const submit = document.getElementById('rideBookBtn');
    if (submit) {
      submit.disabled = !currentQuote.bookable;
      submit.textContent = currentQuote.bookable ? `Pay & Book Ride · ${formatMoney(currentQuote.grandTotal)}` : 'Not bookable';
    }
    return currentQuote;
  }

  async function loadRideDetail(id) {
    const panel = document.getElementById('rideDetail');
    if (!panel || !id) return;
    panel.innerHTML = '<div class="rvx-skeleton" style="height:260px"></div>';
    try {
      let item = (await getRides()).find(ride => ride.id === id);
      if (!item && ['owner', 'admin'].includes(R.getStoredUser()?.role)) {
        try { item = (await api('/rides/mine?all=true')).find(ride => ride.id === id); } catch { /* not an owner */ }
      }
      if (!item) throw new Error('This ride is no longer available. It may still be awaiting admin approval.');
      currentRide = item;
      currentRideId = id;

      panel.innerHTML = `
        ${imageOrInitials(item.vehicleImage, item.vehicle, { className: 'rvx-thumb', alt: `${item.vehicle || 'Vehicle'} on this ride` })}
        <div style="padding:18px;display:grid;gap:14px">
          <div class="rvx-card__head">
            <div style="min-width:0">
              <h1 class="rvx-card__title">${escapeHtml(item.from)} &rarr; ${escapeHtml(item.to)}</h1>
              <p class="rvx-card__meta">${escapeHtml(item.vehicle || 'Vehicle')}${item.numberPlate ? ` · ${escapeHtml(item.numberPlate)}` : ''}</p>
            </div>
            ${statusBadge(item.status)}
          </div>
          <div class="rvx-chips">
            <span class="rvx-chip rvx-chip--route">${escapeHtml(formatDate(item.date))} · ${escapeHtml(item.time || '')}</span>
            <span class="rvx-chip">${escapeHtml(item.vehicleType || 'Car')}</span>
            <span class="rvx-chip">${escapeHtml(item.fuelType || 'Petrol')}</span>
            ${Number(item.distanceKm) > 0 ? `<span class="rvx-chip">${Number(item.distanceKm).toLocaleString('en-IN')} km</span>` : ''}
          </div>
          <div class="rvx-user">
            ${imageOrInitials(item.driverPhoto, item.driver, { className: 'rvx-user-avatar', alt: '' })}
            <span style="min-width:0">
              <span class="rvx-user__name">${escapeHtml(item.driver || 'REVEX driver')}</span>
              <span class="rvx-user__sub">${item.driverPhone ? `Contact ${escapeHtml(item.driverPhone)}` : 'Contact shared once a seat is confirmed'}</span>
            </span>
          </div>
          ${item.notes ? `<p class="rvx-card__meta">${escapeHtml(item.notes)}</p>` : ''}
        </div>`;

      const seatsSelect = document.getElementById('seatCount');
      if (seatsSelect) {
        const max = Math.max(1, Math.min(6, Number(item.seats) || 1));
        seatsSelect.replaceChildren(...Array.from({ length: max }, (_, index) => {
          const option = document.createElement('option');
          option.value = String(index + 1);
          option.textContent = `${index + 1} seat${index ? 's' : ''}`;
          return option;
        }));
        seatsSelect.addEventListener('change', () => { refreshQuote().catch(error => showToast(error.message, 'bad')); });
      }
      await refreshQuote();
      if (location.hash === '#book') document.getElementById('rideBookBtn')?.focus();
    } catch (error) {
      panel.innerHTML = `<div class="rvx-empty"><h3>Ride unavailable</h3><p>${escapeHtml(error.message)}</p><a class="rvx-btn rvx-btn--outline" href="find-ride.html">Back to Find a Ride</a></div>`;
    }
  }

  async function confirmRide(event) {
    event.preventDefault();
    if (!requireLogin() || !currentRideId) return;
    const terms = document.getElementById('rideTerms');
    if (terms && !terms.checked) { showToast('Accept the ride sharing terms before booking.', 'warn'); terms.focus(); return; }
    const submit = event.target.querySelector('button[type="submit"]') || document.getElementById('rideBookBtn');
    if (submit?.disabled) return;

    let booking;
    let config;
    try {
      booking = await api(`/rides/${encodeURIComponent(currentRideId)}/book`, {
        method: 'POST',
        body: { seats: Number(document.getElementById('seatCount')?.value) || 1, termsAccepted: true }
      });
      config = await global.RevexPay.getConfig();
    } catch (error) { showToast(error.message, 'bad', 8000); return; }

    const quote = booking.quote || currentQuote;
    const dialog = paymentDialog({
      quote,
      ride: currentRide,
      config,
      onDismiss: async () => {
        // Releasing the held seats is a real server-side action, not a guess.
        try { await api(`/rides/bookings/${encodeURIComponent(booking.id)}/payment-failed`, { method: 'POST', body: {} }); } catch { /* already released */ }
      }
    });

    const result = await global.RevexPay.settle(dialog.pay, {
      bookingId: booking.id,
      orderPath: `/rides/bookings/${encodeURIComponent(booking.id)}/payment-order`,
      path: `/rides/bookings/${encodeURIComponent(booking.id)}/verify-payment`,
      testPath: `/rides/bookings/${encodeURIComponent(booking.id)}/payment-test`,
      releasePath: `/rides/bookings/${encodeURIComponent(booking.id)}/payment-failed`,
      name: R.getStoredUser()?.name,
      email: R.getStoredUser()?.email,
      description: `${currentRide.from} to ${currentRide.to}`,
      fallbackAmount: quote.grandTotal
    });

    if (result?.status === 'paid') {
      dialog.close();
      showModal('Seat request sent', `₹${formatMoney(quote.grandTotal)} received. ${result.testMode ? 'This was a test payment. ' : ''}The driver has been notified and will approve your seat.`);
      setTimeout(() => { location.href = 'bookings.html#rides'; }, 1600);
    } else if (result?.status === 'dismissed') {
      dialog.close();
    } else {
      dialog.close();
      await loadRideDetail(currentRideId);
    }
  }

  /* -------------------------------------------------- 3. OFFER A RIDE form */

  /**
   * Populates the vehicle picker from the owner's registered vehicles and, when
   * one is selected, uses ITS photo. This is the fix for "the vehicle image is
   * missing in Find Ride": the offer now points at the registered vehicle record
   * instead of holding a separate upload.
   */
  async function populateVehiclePicker(form) {
    const select = form.elements.vehicleId;
    const hint = document.getElementById('offerVehicleHint');
    const preview = document.getElementById('offerVehiclePreview');
    if (!select) return;

    let vehicles = [];
    try { vehicles = await api('/vehicles/mine'); } catch (error) { showToast(error.message, 'bad'); }

    const usable = vehicles.filter(vehicle => ['approved', 'available'].includes(String(vehicle.status || vehicle.availability || '')));
    select.replaceChildren(new Option(usable.length ? 'Choose a registered vehicle…' : 'No approved vehicles yet', ''));
    usable.forEach(vehicle => {
      const option = new Option(`${vehicle.name}${vehicle.numberPlate ? ` · ${vehicle.numberPlate}` : ''}`, vehicle.id);
      select.appendChild(option);
    });
    select.insertAdjacentHTML('afterend', `<option value="__custom">${usable.length ? 'Enter the vehicle details manually' : 'Enter the vehicle details manually (no approved vehicle yet)'}</option>`);

    const apply = () => {
      const value = select.value;
      const vehicle = usable.find(item => item.id === value);
      const isCustom = !vehicle;
      // Fields that come from the registered vehicle are read-only while one
      // is selected, so the offer can never contradict the listing.
      ['vehicle', 'numberPlate', 'vehicleType', 'fuelType'].forEach(name => {
        const field = form.elements[name];
        if (!field) return;
        field.readOnly = Boolean(vehicle) && ['vehicle', 'numberPlate'].includes(name);
        field.disabled = Boolean(vehicle) && ['vehicleType', 'fuelType'].includes(name);
      });
      if (vehicle) {
        form.elements.vehicle.value = vehicle.name || vehicle.brand || vehicle.model || '';
        form.elements.numberPlate.value = vehicle.numberPlate || '';
        form.elements.vehicleType.value = vehicle.category || vehicle.type || 'Car';
        form.elements.fuelType.value = vehicle.fuelType || 'Petrol';
      }
      if (preview) {
        preview.innerHTML = vehicle
          ? imageOrInitials(vehicle.vehiclePicture || vehicle.image, vehicle.name, { className: 'rvx-thumb rvx-thumb--sm', alt: '' })
          : '<span class="rvx-card__meta">No vehicle selected.</span>';
      }
      if (hint) {
        hint.textContent = vehicle
          ? `Using the photo and details of "${vehicle.name}". Find a Ride will show this exact image.`
          : usable.length
            ? 'Pick a registered vehicle to reuse its photo, or type the details manually.'
            : 'You have no approved vehicle yet. List and get a vehicle approved first, then your ride can reuse its photo.';
      }
      const upload = document.getElementById('offerManualPhoto');
      if (upload) upload.hidden = Boolean(vehicle);
    };

    select.addEventListener('change', apply);
    apply();
  }

  async function handleOfferSubmit(event) {
    event.preventDefault();
    const form = event.target;
    if (!requireRole('owner', 'admin')) return;
    const terms = form.elements.termsAccepted;
    if (terms && !terms.checked) { showToast('Accept the ride sharing terms before submitting.', 'warn'); terms.focus(); return; }

    const submit = form.querySelector('button[type="submit"]');
    const original = submit?.innerHTML;
    if (submit) { submit.disabled = true; submit.innerHTML = '<span class="rvx-spinner" aria-hidden="true"></span> Submitting…'; }

    try {
      const vehicleId = form.elements.vehicleId?.value || '';
      const linked = vehicleId && vehicleId !== '__custom' ? vehicleId : '';
      let vehicleImage = '';
      const file = form.vehicleImage?.files?.[0];
      if (!linked && file) vehicleImage = await readFileAsDataUrl(file);

      const ride = await api('/rides', {
        method: 'POST',
        body: {
          vehicleId: linked || undefined,
          from: form.from.value.trim(),
          to: form.to.value.trim(),
          date: form.date.value,
          time: form.time.value,
          seats: Number(form.seats.value),
          price: Number(form.price.value),
          additionalCharges: Number(form.additionalCharges?.value || 0),
          discountPercent: Number(form.discountPercent?.value || 0),
          distanceKm: Number(form.distanceKm?.value || 0),
          vehicle: form.vehicle.value.trim(),
          vehicleType: form.vehicleType.value,
          fuelType: form.fuelType?.value || 'Petrol',
          numberPlate: form.numberPlate.value.trim(),
          driverPhone: form.driverPhone?.value.trim() || '',
          notes: form.notes?.value.trim() || '',
          pickupPoint: form.pickupPoint?.value.trim() || '',
          vehicleImage,
          termsAccepted: true
        }
      });
      showModal('Ride offer submitted', ride.message || 'An admin will review your offer before it appears on Find a Ride.');
      form.reset();
      if (form.elements.vehicleId) form.elements.vehicleId.dispatchEvent(new Event('change'));
    } catch (error) {
      showToast(error.message, 'bad', 9000);
    } finally {
      if (submit) { submit.disabled = false; submit.innerHTML = original; }
    }
  }

  /* ----------------------------------------------------------------- boot */

  document.addEventListener('DOMContentLoaded', () => {
    const results = document.getElementById('rideResults');
    if (results) {
      const search = document.getElementById('rideSearch');
      const run = async params => {
        results.innerHTML = '<div class="rvx-grid"><div class="rvx-skeleton" style="height:280px"></div><div class="rvx-skeleton" style="height:280px"></div><div class="rvx-skeleton" style="height:280px"></div></div>';
        try { await renderRides(await getRides(params), results); }
        catch (error) { results.innerHTML = `<div class="rvx-empty"><h3>Rides could not be loaded</h3><p>${escapeHtml(error.message)}</p></div>`; }
      };
      run({});
      search?.addEventListener('submit', event => {
        event.preventDefault();
        run({ from: search.from.value, to: search.to.value, date: search.date.value, vehicleType: search.vehicleType.value });
      });
      const clear = document.getElementById('rideSearchReset');
      clear?.addEventListener('click', () => { if (search) search.reset(); run({}); });
    }

    const offer = document.getElementById('offerRide');
    if (offer) {
      populateVehiclePicker(offer).catch(error => showToast(error.message, 'bad'));
      offer.addEventListener('submit', handleOfferSubmit);
      // A date picker that defaults to today cannot produce a valid offer.
      const date = offer.elements.date;
      if (date && !date.value) {
        const tomorrow = new Date(Date.now() + 86400000);
        date.value = tomorrow.toISOString().slice(0, 10);
        date.min = new Date().toISOString().slice(0, 10);
      }
    }

    const bookForm = document.getElementById('rideBookForm');
    if (bookForm) {
      bookForm.addEventListener('submit', confirmRide);
      loadRideDetail(new URLSearchParams(location.search).get('id'));
    }
  });

  global.RevexRides = { getRides, refreshQuote };
})(window);

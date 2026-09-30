/* ============================================================================
 * VEHICLE RENTAL  (js/rental.js)
 *
 * The renter-facing screens: rental.html (search grid) and vehicle-details.html
 * (book with a transparent breakdown).
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
    api, escapeHtml, formatMoney, formatDate, formatDateTime, assetUrl,
    getStoredUser, requireLogin, showModal, showToast, imageOrInitials
  } = REVEX;
  // The client-side preview, exported by js/pricing.js. The server value always
  // wins: the backend recomputes every amount from the stored vehicle.
  //
  // `quoteRows` MUST be destructured here too. It is what actually paints the
  // breakdown. Leaving it out made `quoteRows(quote)` throw
  // "ReferenceError: quoteRows is not defined" inside renderQuote(), and because
  // renderQuote() assigns innerHTML as one expression, the throw happened BEFORE
  // anything was written - so the box kept its original "Choose valid future
  // times" message even though the server had just returned a perfect quote.
  // refreshQuote() then caught it, the fallback path threw at the same line, and
  // the user was shown a generic message about their dates while the real cause
  // was a missing import. The submit button stayed disabled, so no booking could
  // ever be made.
  const { calculateClientQuote, quoteRows } = global.RevexPricing || {};
  if (typeof quoteRows !== 'function') {
    // Fail loudly in development rather than silently showing the wrong message.
    console.error('[rental] js/pricing.js did not load, so the price breakdown cannot be rendered.');
  }
let currentVehicle = null;
let currentQuote = null;
let quoteRequest = 0;
/*
 * The exact window `currentQuote` was calculated for, as `start|end|km`.
 *
 * This exists to make one guarantee impossible to break:
 *
 *   A total is displayed, and the submit button is enabled, ONLY for the window
 *   currently in the form.
 *
 * Without it, `refreshQuote()` dropped any response that arrived after a newer
 * request had started (`if (requestId !== quoteRequest) return`). Editing the
 * dates one field at a time - which is how every real person types - meant the
 * last valid quote stayed on screen even though the form had moved on. The box
 * kept showing the default 2-hour total (₹679) while the dates said 57 hours
 * (₹19,078), and the button stayed enabled, so the renter confirmed one number
 * and the server charged another. The server is the authority for the charge, so
 * the displayed figure has to be pinned to the window it belongs to.
 */
let quoteFor = '';
// The window the renter chose in the search grid, carried into the detail page
// so the booking form is pre-filled instead of asking them to type it again.
let selectedWindow = { startDate: '', endDate: '' };

function detailHref(id) {
  const params = new URLSearchParams({ id });
  if (selectedWindow.startDate) params.set('start', selectedWindow.startDate);
  if (selectedWindow.endDate) params.set('end', selectedWindow.endDate);
  return `vehicle-details.html?${params.toString()}`;
}

function vehicleImageMarkup(vehicle, className = '') {
  // The shared image helper falls back to the vehicle's initials, so a missing
  // or broken photo shows those initials instead of a "Vehicle Image
  // Unavailable" placeholder graphic that looked like a bug.
  return `<div class="vehicle-image ${className}">${imageOrInitials(vehicle.image || vehicle.vehiclePicture, vehicle.name, { className: '', alt: vehicle.name || 'Vehicle' })}</div>`;
}
function vehicleCard(vehicle) {
  const category = vehicle.category || vehicle.type || 'Other'; const unit = vehicle.priceUnit || 'hour';
  return `<article class="vehicle-card">${vehicleImageMarkup(vehicle)}<div class="card-body"><div class="card-top"><div><div class="badge-row"><span class="badge badge-category">${escapeHtml(category.toUpperCase())}</span><span class="badge badge-fuel">${escapeHtml(vehicle.fuelType || 'Petrol').toUpperCase()}</span></div><h3 class="card-title">${escapeHtml(vehicle.name || 'Vehicle')}</h3><p class="card-meta">${escapeHtml([vehicle.brand, vehicle.model].filter(Boolean).join(' ') || vehicle.name)} · ${escapeHtml(vehicle.location || '-')}</p></div><span class="star-rating" title="Rating">★ ${Number(vehicle.rating || 5).toFixed(1)}</span></div><div class="vehicle-facts"><span>${escapeHtml(vehicle.transmission || 'Manual')}</span><span>${Number(vehicle.currentKm || 0).toLocaleString('en-IN')} km</span><span>${vehicle.availableFrom && new Date(vehicle.availableFrom) > new Date() ? `From ${formatDate(vehicle.availableFrom)}` : (vehicle.availability === 'unavailable' ? 'Unavailable' : 'Available')}</span></div><p class="card-price">${formatMoney(vehicle.price)} <small>/ ${escapeHtml(unit)}</small>${vehicle.discountPercent ? `<small> · ${vehicle.discountPercent}% off</small>` : ''}</p><div class="card-actions"><a class="btn btn-outline" href="${escapeHtml(detailHref(vehicle.id))}">View details</a><a class="btn btn-primary" href="${escapeHtml(detailHref(vehicle.id))}">Book now</a></div></div></article>`;
}
async function renderVehicles(filters = {}) {
  const box = document.getElementById('vehicleResults'); if (!box) return;
  const note = document.getElementById('rentalAvailabilityNote');
  box.innerHTML = '<div class="empty">Loading vehicles…</div>';
  if (note) note.textContent = '';
  // Remember the window so every card link can carry it to the booking page.
  selectedWindow = { startDate: filters.startDate || '', endDate: filters.endDate || '' };
  try {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== null && String(value).trim()) params.set(key, value.trim()); });
    const vehicles = await api(`/vehicles?${params.toString()}`);
    const windowText = (filters.startDate && filters.endDate) ? `${formatDate(filters.startDate)} to ${formatDate(filters.endDate)}` : '';

    // If the chosen window has nothing free, do not just show an empty grid:
    // list the approved vehicles anyway so the renter can see why, and give a
    // one-click way to move the pick-up date to the first free day.
    if (!vehicles.length && filters.includeUpcoming !== 'true') {
      let upcoming = [];
      try {
        const relaxed = new URLSearchParams(params);
        relaxed.set('includeUpcoming', 'true');
        upcoming = await api(`/vehicles?${relaxed.toString()}`);
      } catch { /* fall through to the empty state */ }

      if (upcoming.length) {
        const soonest = upcoming.map(v => v.availableFrom).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0];
        if (note) {
          note.innerHTML = `No vehicle is free ${escapeHtml(windowText || 'right now')}. ` +
            `${upcoming.length} approved vehicle${upcoming.length === 1 ? ' is' : 's are'} listed below with the first date available.`;
        }
        const jump = soonest
          ? `<button class="btn btn-primary" type="button" data-jump-date="${escapeHtml(new Date(soonest).toISOString().slice(0, 10))}">Use ${escapeHtml(formatDate(soonest))} as my pick-up date</button>`
          : '';
        box.innerHTML = jump + upcoming.map(vehicleCard).join('');
        return;
      }
    }

    if (note) {
      note.textContent = vehicles.length
        ? `${vehicles.length} vehicle${vehicles.length === 1 ? '' : 's'} available${windowText ? ` for ${windowText}` : ' now'}.`
        : `No approved vehicles are free${windowText ? ` for ${windowText}` : ' right now'}.`;
    }
    box.innerHTML = vehicles.length
      ? vehicles.map(vehicleCard).join('')
      : '<div class="empty">No approved vehicles match those dates and filters. Try a later pick-up date.</div>';
  } catch (error) { box.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
function updateQuoteButton() {
  const button = document.querySelector('#rentalBooking button[type="submit"]'); const consent = document.getElementById('agreementConsent');
  // The quote must belong to the window in the form RIGHT NOW. Checked here as
  // well as in refreshQuote(), so no code path can leave a stale total actionable.
  if (button) button.disabled = !currentQuote || !consent?.checked || quoteFor !== currentWindowKey();
}
/** `start|end|km` for the window currently in the form. */
function currentWindowKey() {
  const form = document.getElementById('rentalBooking');
  if (!form || !form.startDate?.value || !form.startTime?.value || !form.endDate?.value || !form.endTime?.value) return '';
  return windowKey(`${form.startDate.value}T${form.startTime.value}`, `${form.endDate.value}T${form.endTime.value}`, form.estimatedKm?.value || 0);
}
function windowKey(startIso, endIso, km) { return `${startIso}|${endIso}|${km}`; }
function invalidateQuote() { currentQuote = null; quoteFor = ''; }
/**
 * Paints the price breakdown.
 *
 * `reason` distinguishes the three genuinely different empty states, because
 * collapsing them into one message is what made this bug so hard to diagnose:
 *
 *   undefined -> no window has been entered yet          (neutral)
 *   'window'  -> the window is empty, reversed or past    (the user's dates)
 *   'error'   -> something else went wrong               (our fault, not theirs)
 *
 * A render failure is also reported rather than swallowed. Previously a throw
 * from quoteRows() left the previous markup in place, so the box kept saying
 * "choose valid future times" while the real fault was a missing import.
 */
function renderQuote(quote, reason) {
  const box = document.getElementById('rentalBreakdown');
  if (!box) return;
  if (!quote) {
    const message = reason === 'error'
      ? 'The price could not be calculated just now. Please try again, and if it keeps happening tell the operator.'
      : reason === 'calculating'
        ? 'Working out the price for these dates…'
        : 'Choose valid future times to see the price breakdown.';
    box.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    updateQuoteButton();
    return;
  }
  let rows;
  try {
    rows = quoteRows(quote);
  } catch (error) {
    // Show the amount even if a single line item cannot be formatted, rather
    // than dropping the whole breakdown and blaming the dates.
    console.error('[rental] could not render the price breakdown:', error);
    const total = quote.grandTotal ?? quote.totalAmount ?? quote.additionalCharge ?? 0;
    box.innerHTML = `<div class="quote-heading"><strong>Rental Amount</strong><span>${escapeHtml(quote.durationLabel || '')}</span></div>`
      + `<div class="quote-row"><span>Estimated total</span><b>${escapeHtml(formatMoney(total))}</b></div>`
      + '<div class="empty">Some line items could not be shown. The server total is correct and is used for payment.</div>';
    updateQuoteButton();
    return;
  }
  // The heading used to read "Rental Amount", which is also the first row's
  // label, so the box showed "Rental Amount" twice. The rows itemise the total,
  // so the heading names the section instead.
  box.innerHTML = `<div class="quote-heading"><strong>Price breakdown</strong><span>${escapeHtml(quote.durationLabel || `${quote.durationHours} hour(s)`)}</span></div>${rows}`;
  updateQuoteButton();
}
async function refreshQuote() {
  const form = document.getElementById('rentalBooking'); if (!form || !currentVehicle) return;
  const start = form.startDate?.value; const end = form.endDate?.value; const km = form.estimatedKm?.value || 0;
  if (!start || !form.startTime?.value || !end || !form.endTime?.value) { invalidateQuote(); renderQuote(null, 'window'); return; }
  const startIso = `${start}T${form.startTime.value}`;
  const endIso = `${end}T${form.endTime.value}`;
  const key = windowKey(startIso, endIso, km);

  /*
   * The instant the window changes, the old total stops being true. Clear it and
   * disable the button BEFORE awaiting anything, so there is no moment - not
   * even on a slow connection - where a stale price is both visible and
   * clickable. Before this, editing the dates one field at a time left the
   * default 2-hour total on screen (₹679) while the form said 57 hours
   * (₹19,078); the renter would have confirmed one number and been charged
   * another, because the SERVER total is the one that is taken.
   */
  if (key !== quoteFor) {
    invalidateQuote();
    renderQuote(null, 'calculating');
  }

  const requestId = ++quoteRequest;
  const params = new URLSearchParams({ startDate: startIso, endDate: endIso, estimatedKm: km });
  try {
    const quote = await api(`/vehicles/${encodeURIComponent(currentVehicle.id)}/quote?${params.toString()}`);
    if (requestId !== quoteRequest) return;    // a newer edit already won
    if (key !== currentWindowKey()) return;    // the form moved again mid-flight
    currentQuote = quote; quoteFor = key;
    renderQuote(quote);
  } catch (error) {
    if (requestId !== quoteRequest) return;
    if (key !== currentWindowKey()) return;
    /*
     * The server refused the window (or was unreachable). Try the local preview
     * so the renter still sees something, but only ever for the SAME window; if
     * that also fails, say why instead of blaming the dates.
     */
    console.warn('[rental] the server quote failed:', error.message);
    try {
      const quote = calculateClientQuote(currentVehicle, startIso, endIso, km);
      currentQuote = quote; quoteFor = key;
      renderQuote(quote);
    } catch {
      invalidateQuote();
      // The server's own message is the accurate one when it gave one.
      const fromServer = /valid|required|past|before|after|date|time|future/i.test(error.message || '');
      renderQuote(null, fromServer ? 'window' : 'error');
    }
  }
}
function calculateRental() { refreshQuote(); }
function setSafeBookingDefaults() {
  const form = document.getElementById('rentalBooking'); if (!form) return;

  const date = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const time = value => `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  const parseDay = value => { if (!value) return null; const d = new Date(`${value}T00:00:00`); return Number.isNaN(d.getTime()) ? null : d; };
  const nextQuarterHour = from => { const c = new Date(from); c.setMinutes(Math.ceil((c.getMinutes() + 1) / 15) * 15, 0, 0); if (c <= new Date()) c.setHours(c.getHours() + 1); return c; };

  // The renter may have chosen a window in the search grid; honour it.
  const url = new URLSearchParams(window.location.search);
  const wantedStart = parseDay(url.get('start'));
  const wantedEnd = parseDay(url.get('end'));

  // A vehicle whose owner set a future "available from" cannot be booked before
  // that day, so never pre-fill a start time the server would reject.
  const availFrom = currentVehicle?.availableFrom ? new Date(currentVehicle.availableFrom) : null;
  const earliest = availFrom && availFrom > new Date() ? availFrom : null;

  let start = earliest ? nextQuarterHour(earliest) : nextQuarterHour(new Date());
  if (wantedStart && (!earliest || wantedStart >= earliest)) {
    const sameDay = new Date(wantedStart); sameDay.setHours(10, 0, 0, 0);
    if (sameDay > new Date()) start = sameDay;
  }

  let end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  if (wantedEnd && wantedEnd > start) end = wantedEnd;

  if (form.startDate) { form.startDate.value = date(start); form.startDate.min = earliest ? date(earliest) : date(start); form.startTime.value = time(start); }
  if (form.endDate) { form.endDate.value = date(end); form.endDate.min = date(start); form.endTime.value = time(end); }
  refreshQuote();
}
/**
 * The rental payment step.
 *
 * It now goes through the SAME shared client (js/payment.js) as the ride flow,
 * so both screens:
 *   - ask the server which method is available instead of assuming,
 *   - open a real Razorpay checkout when keys are configured,
 *   - offer a clearly labelled test payment when they are not,
 *   - are protected by the same single-settlement latch, so a double click
 *     cannot create two bookings for one payment.
 */
async function openPaymentModal(booking) {
  const modal = document.getElementById('simplePaymentModal');
  const amount = document.getElementById('simplePaymentAmount');
  const total = booking.quote?.grandTotal ?? booking.grandTotal ?? booking.totalAmount ?? 0;
  if (amount) amount.textContent = formatMoney(total);

  const config = await window.RevexPay.getConfig();
  const note = document.getElementById('simplePaymentNote');
  if (note) {
    note.className = `rvx-notice rvx-notice--${config.usable ? 'info' : 'warn'}`;
    note.innerHTML = config.usable
      ? '<div><strong>Razorpay checkout.</strong> Your booking is confirmed only after the server verifies the payment signature.</div>'
      : `<div><strong>Test payment.</strong> ${escapeHtml(config.testModeLabel || 'No working payment gateway is configured on this server')}, so a labelled test payment is recorded instead. No real money moves.</div>`;
  }

  const pay = document.getElementById('simplePayNow');
  if (pay) pay.textContent = config.usable ? `Pay ${formatMoney(total)}` : `Record test payment · ${formatMoney(total)}`;
  modal?.classList.add('show');

  return new Promise((resolve, reject) => {
    const close = () => modal?.classList.remove('show');
    const releaseAndReject = async () => {
      close();
      try { await api(`/bookings/${encodeURIComponent(booking.id)}/payment-failed`, { method: 'POST', body: {} }); } catch { /* already released */ }
      reject(new Error('Payment was cancelled.'));
    };
    const onPay = async () => {
      try {
        const result = await window.RevexPay.settle(pay, {
          bookingId: booking.id,
          orderPath: `/bookings/${encodeURIComponent(booking.id)}/payment-order`,
          path: `/bookings/${encodeURIComponent(booking.id)}/verify-payment`,
          testPath: `/bookings/${encodeURIComponent(booking.id)}/payment-test`,
          releasePath: `/bookings/${encodeURIComponent(booking.id)}/payment-failed`,
          name: getStoredUser()?.name,
          email: getStoredUser()?.email,
          description: `${currentVehicle?.name || 'REVEX vehicle'} rental`,
          fallbackAmount: total
        });
        if (result?.status === 'paid') {
          close();
          showModal('Payment received', `${result.testMode ? 'Test payment recorded. ' : ''}Booking ${booking.id} is paid and waiting for owner approval. Agreement: ${booking.agreement?.agreementId || 'prepared'}.`);
          const download = document.getElementById('downloadAgreementBtn');
          if (download) { download.style.display = 'inline-flex'; download.onclick = () => downloadAgreement(booking.id); }
          resolve(result);
        } else {
          close();
          reject(new Error('Payment could not be completed.'));
        }
      } catch (error) {
        close();
        reject(error);
      }
    };
    if (pay) pay.onclick = onPay;
    const cancel = document.getElementById('simplePayCancel');
    if (cancel) cancel.onclick = releaseAndReject;
    modal?.addEventListener('click', event => { if (event.target === modal) releaseAndReject(); }, { once: true });
  });
}

async function confirmRental(event) {
  event.preventDefault();
  if (!requireLogin()) throw new Error('Please sign in before booking this vehicle.');
  const form = event.target; const consent = document.getElementById('agreementConsent');
  if (!form.reportValidity()) throw new Error('Please complete all required rental fields.');
  if (!consent?.checked) { showToast('Please read and accept the Rental Agreement and Terms & Conditions.', 'warn'); consent?.focus(); throw new Error('Please accept the Rental Agreement and Terms & Conditions.'); }
  /*
   * Re-validate at the moment of submission, not just at paint time. If the
   * dates changed since the last quote landed, get a fresh one and make the
   * renter confirm again, rather than charging the server's figure for a window
   * they never saw priced.
   */
  if (!currentQuote || quoteFor !== currentWindowKey()) {
    await refreshQuote();
    if (!currentQuote || quoteFor !== currentWindowKey()) {
      showToast('Choose valid future booking times so the price can be worked out.', 'warn');
      throw new Error('Choose valid future booking times so the price can be worked out.');
    }
  }
  try {
    const booking = await api('/bookings', { method: 'POST', body: { vehicleId: currentVehicle.id, startDate: `${form.startDate.value}T${form.startTime.value}`, endDate: `${form.endDate.value}T${form.endTime.value}`, estimatedKm: Number(form.estimatedKm.value) || 0, panNumber: form.panNumber.value.trim(), drivingLicenseNumber: form.drivingLicenseNumber.value.trim(), agreementAccepted: true, termsVersion: 'revex-v3' } });
    currentQuote = booking.quote || booking.pricing || currentQuote;
    quoteFor = currentWindowKey();
    await openPaymentModal(booking);
  } catch (error) { showToast(error.message || 'Booking failed.', 'bad', 8000); throw error; }
}

window.RevexLoadingActions = window.RevexLoadingActions || {};
window.RevexLoadingActions.rentalBook = () => {
  const form = document.getElementById('rentalBooking');
  if (!form) throw new Error('Rental booking form is not available.');
  return confirmRental({ preventDefault() {}, target: form });
};

document.addEventListener('DOMContentLoaded', async () => {
  const search = document.getElementById('rentalSearch');
  if (search) {
    // Default to tomorrow -> +2 days so the first load shows vehicles that are
    // free now as well as ones an owner scheduled for a near-future date.
    const today = new Date();
    const iso = offset => {
      const d = new Date(today); d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    const startInput = document.getElementById('rentalStart');
    const endInput = document.getElementById('rentalEnd');
    if (startInput) { startInput.value = iso(0); startInput.min = iso(0); }
    if (endInput) { endInput.value = iso(2); endInput.min = iso(1); }

    const collect = () => ({
      startDate: startInput?.value || '',
      endDate: endInput?.value || '',
      location: search.location?.value,
      category: search.category?.value,
      fuelType: search.fuelType?.value,
      maxPrice: search.maxPrice?.value,
      sort: document.getElementById('rentalSort')?.value
    });

    await renderVehicles(collect());
    search.addEventListener('submit', event => { event.preventDefault(); renderVehicles(collect()); });
    // Changing a date re-queries immediately: the renter should not have to
    // press Search again to see which vehicles are free.
    startInput?.addEventListener('change', () => {
      if (endInput && startInput.value && (!endInput.value || endInput.value <= startInput.value)) {
        const d = new Date(startInput.value); d.setDate(d.getDate() + 2);
        endInput.value = d.toISOString().slice(0, 10);
        endInput.min = startInput.value;
      }
      renderVehicles(collect());
    });
    endInput?.addEventListener('change', () => {
      if (startInput && endInput.value && endInput.value <= startInput.value) {
        const d = new Date(endInput.value); d.setDate(d.getDate() + 1);
        startInput.value = d.toISOString().slice(0, 10);
      }
      renderVehicles(collect());
    });
    document.getElementById('rentalSort')?.addEventListener('change', () => renderVehicles(collect()));
    // "Use <date> as my pick-up date" from the empty-state fallback.
    document.getElementById('vehicleResults')?.addEventListener('click', event => {
      const jump = event.target.closest('[data-jump-date]');
      if (!jump) return;
      const picked = jump.dataset.jumpDate;
      if (startInput) startInput.value = picked;
      if (endInput) {
        const d = new Date(picked); d.setDate(d.getDate() + 2);
        endInput.value = d.toISOString().slice(0, 10);
      }
      renderVehicles(collect());
    });
  }
  const detail = document.getElementById('vehicleDetail');
  if (!detail) return;
  const id = new URLSearchParams(location.search).get('id');
  if (!id) { detail.innerHTML = '<div class="empty">Vehicle ID is missing.</div>'; return; }
  try {
    currentVehicle = await api(`/vehicles/${encodeURIComponent(id)}`);
    if (currentVehicle.status !== 'approved' || !currentVehicle.verified) throw new Error('This vehicle is not currently available for booking.');
    const image = currentVehicle.image || currentVehicle.vehiclePicture || '';
    detail.innerHTML = `${vehicleImageMarkup(currentVehicle, 'detail-image')}<div class="badge-row"><span class="badge badge-category">${escapeHtml((currentVehicle.category || currentVehicle.type || 'Other').toUpperCase())}</span><span class="badge badge-fuel">${escapeHtml(currentVehicle.fuelType || 'Petrol').toUpperCase()}</span><span class="pill">${currentVehicle.verified ? 'Approved' : 'Pending approval'}</span></div><h1 class="section-title">${escapeHtml(currentVehicle.name)}</h1><p class="detail-subtitle">${escapeHtml([currentVehicle.brand, currentVehicle.model].filter(Boolean).join(' ') || 'Verified vehicle')} · ${escapeHtml(currentVehicle.location || '-')}</p><div class="detail-facts"><div><b>Category</b>${escapeHtml(currentVehicle.category || currentVehicle.type || '-')}</div><div><b>Fuel</b>${escapeHtml(currentVehicle.fuelType || '-')}</div><div><b>Transmission</b>${escapeHtml(currentVehicle.transmission || 'Manual')}</div><div><b>Odometer</b>${Number(currentVehicle.currentKm || 0).toLocaleString('en-IN')} km</div><div><b>Rating</b><span class="star-rating">★ ${Number(currentVehicle.rating || 5).toFixed(1)}</span></div><div><b>Owner</b>${escapeHtml(currentVehicle.owner?.name || 'Vehicle owner')}</div><div><b>Available from</b>${currentVehicle.availableFrom ? escapeHtml(formatDate(currentVehicle.availableFrom)) : 'Any time'}</div></div><hr><h2 class="section-title small-title">Book with a transparent breakdown</h2><p>${escapeHtml(currentVehicle.description || 'Well maintained and verified for a smooth rental.')}</p>`;
    const priceInput = document.getElementById('hourlyPrice'); if (priceInput) priceInput.value = currentVehicle.price;
    const form = document.getElementById('rentalBooking');
    if (form) {
      form.dataset.vehicleId = currentVehicle.id;
      form.addEventListener('input', refreshQuote);
      form.addEventListener('change', refreshQuote);
      // Bound here, not with an inline onsubmit attribute in the markup:
      // `confirmRental` is inside this IIFE and was never on `window`, so the
      // inline handler threw, preventDefault() never ran, and the browser
      // performed a default GET submit that leaked the PAN number and driving
      // licence number into the URL. Always call preventDefault first.
      form.addEventListener('submit', event => { event.preventDefault(); confirmRental(event).catch(() => {}); });
      document.getElementById('agreementConsent')?.addEventListener('change', updateQuoteButton);
      setSafeBookingDefaults();
    }
  } catch (error) { detail.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; document.getElementById('rentalBooking')?.querySelectorAll('input,select,button').forEach(control => { control.disabled = true; }); }
});

})(window);

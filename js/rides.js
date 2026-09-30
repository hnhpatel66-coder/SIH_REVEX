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
  // Debounce handle for the join box, so typing a town name does not fire a
  // routing request per keystroke.
  let joinTimer = null;
  // The single end the smart-search map is currently pinning, or '' for none.
  let pinningEnd = '';
  // The same idea for the booking screen's map, which pins a pickup OR a drop.
  let joiningEnd = '';

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

  /* --------------------------------------------------------- the route map */

  // One map configuration per page load, fetched once. It carries the Mapbox
  // PUBLIC token only - the server-side secret token is never sent to a browser.
  let mapConfig = null;
  const openMaps = new Map();

  async function routeMapConfig() {
    if (mapConfig) return mapConfig;
    try {
      mapConfig = await api('/rides/map-config');
    } catch {
      // A missing or failing map configuration is NOT a failure of the feature.
      // The route diagram renderer works with no key at all.
      mapConfig = { enabled: false, reason: 'Map configuration could not be loaded, so the route diagram is shown.' };
    }
    return mapConfig;
  }

  /** Creates the map for a container once, then reuses it. */
  async function routeMap(containerId, options = {}) {
    const host = document.getElementById(containerId);
    if (!host || !global.RevexRouteMap) return null;
    let map = openMaps.get(containerId);
    if (!map) {
      map = global.RevexRouteMap.create(host, { ariaLabel: options.ariaLabel || 'Route map', ...options });
      openMaps.set(containerId, map);
    }
    await map.setConfig(await routeMapConfig());
    return map;
  }

  /** Where the rider said they will join and leave, if they said anything. */
  function joinPoints(prefix) {
    const text = suffix => (document.getElementById(`${prefix}${suffix}`)?.value || '').trim();
    const coord = suffix => {
      const raw = text(suffix);
      if (!raw) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    return {
      from: text('From'),
      to: text('To'),
      pickupLng: coord('PickupLng'),
      pickupLat: coord('PickupLat'),
      // A drop is a point the rider chose, exactly like a pickup. Carrying it is
      // what lets a pinned drop be measured board -> drop instead of being sent
      // nowhere and quietly turning into "ride to the driver's destination".
      dropLng: coord('DropLng'),
      dropLat: coord('DropLat')
    };
  }

  function hasJoinPoints(points) {
    return Boolean(points && (points.from || points.to
      || points.pickupLng !== undefined || points.dropLng !== undefined));
  }

  /**
   * Appends the rider's points to a query, leaving it untouched when there are none.
   *
   * A pin is sent as coordinates only. No name is invented for it here: the
   * server names it by reverse geocoding, which is the only place that can do it
   * properly. Sending a placeholder name alongside the pin would be worse than
   * useless - it is a label the server no longer needs, and one that would end
   * up on the booking record if the server ever preferred it.
   */
  function withJoinPoints(query, points) {
    if (!hasJoinPoints(points)) return query;
    if (points.from) query.set('from', points.from);
    if (points.to) query.set('to', points.to);
    if (points.pickupLng !== undefined && points.pickupLat !== undefined) {
      query.set('pickupLng', String(points.pickupLng));
      query.set('pickupLat', String(points.pickupLat));
    }
    if (points.dropLng !== undefined && points.dropLat !== undefined) {
      query.set('dropLng', String(points.dropLng));
      query.set('dropLat', String(points.dropLat));
    }
    return query;
  }

  /** The same points as a request body, for the booking POST. */
  function joinPayload(body, points) {
    const payload = { ...body };
    if (!hasJoinPoints(points)) return payload;
    if (points.from) payload.from = points.from;
    if (points.to) payload.to = points.to;
    if (points.pickupLng !== undefined && points.pickupLat !== undefined) {
      payload.pickupLng = points.pickupLng;
      payload.pickupLat = points.pickupLat;
    }
    // The booking rebuilds the plan server-side from these, so a pinned drop
    // that is not sent here would be priced as a ride to the driver's own
    // destination - the quote and the map would then disagree.
    if (points.dropLng !== undefined && points.dropLat !== undefined) {
      payload.dropLng = points.dropLng;
      payload.dropLat = points.dropLat;
    }
    return payload;
  }

  /** "315.2 km by road · about 4 h 8 m · via Rajkot" */
  function routeChips(route) {
    if (!route) return '';
    const chips = [];
    const km = Number(route.distanceKm) || 0;
    const minutes = Number(route.durationMin) || 0;
    if (km > 0) chips.push(`${km} km by road`);
    if (minutes > 0) {
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      chips.push(hours ? (rest ? `about ${hours} h ${rest} m` : `about ${hours} h`) : `about ${rest} m`);
    }
    const via = (route.via || []).map(entry => entry?.name).filter(Boolean);
    if (via.length) chips.push(`via ${via.join(', ')}`);
    if (!chips.length) return '';
    return chips.map(chip => `<span class="rvx-chip rvx-chip--route">${escapeHtml(chip)}</span>`).join('');
  }

  /**
   * "2 towns in between" and what they are.
   *
   * This is the question a rider asks before booking half of somebody else's
   * road: not just how far, but what is on the way. The count is the server's,
   * not `towns.length`, so the headline and the list below it can never
   * disagree - and the list is the evidence for the headline, which is what
   * makes the number believable rather than decorative.
   */
  function checkpointStrip(checkpoints) {
    const data = checkpoints || {};
    const towns = (data.towns || []).filter(town => town && town.name);
    const count = Number.isFinite(Number(data.townsBetween))
      ? Math.max(0, Math.trunc(Number(data.townsBetween)))
      : null;
    if (count === null && !towns.length) return '';
    const head = count === null
      ? ''
      : (count === 0
        ? 'No towns in between'
        : `${count} ${count === 1 ? 'town' : 'towns'} in between`);
    const legs = (data.distances || [])
      .filter(mark => Number(mark && mark.km) > 0)
      .map(mark => `${Math.round(Number(mark.km))} km`);
    return `
      <div class="rvx-stops">
        ${head ? `<p class="rvx-stops__head">${escapeHtml(head)}</p>` : ''}
        ${towns.length ? `<ol class="rvx-stops__list">${towns.map(town => `
          <li class="rvx-stops__item">
            <span class="rvx-stops__name">${escapeHtml(town.name)}</span>
            ${Number(town.fromBoardKm) > 0 ? `<span class="rvx-stops__km">${Math.round(Number(town.fromBoardKm))} km in</span>` : ''}
          </li>`).join('')}</ol>` : ''}
        ${legs.length ? `<p class="rvx-stops__marks">Distance marks: ${escapeHtml(legs.join(' · '))}</p>` : ''}
      </div>`;
  }

  function seatsText(ride) {
    const left = Number(ride.seatsAvailable ?? ride.seats ?? 0);
    if (ride.soldOut || left <= 0) return 'Sold out';
    return left === 1 ? '1 seat left' : `${left} seats left`;
  }

  /* ------------------------------------------------- 1. FIND A RIDE (list) */

  /* --------------------------------------------------------- smart search */

  function smartPinLabel() {
    return pinningEnd === 'pickup' ? 'Click the map to set your pickup'
      : (pinningEnd === 'drop' ? 'Click the map to set your drop' : 'Pin my pickup');
  }

  /** Turns pinning on for one end of the journey, or off for both. */
  function setSmartPin(end) {
    pinningEnd = pinningEnd === end ? '' : end;
    const pickup = document.getElementById('smartPinPickup');
    const drop = document.getElementById('smartPinDrop');
    if (pickup) {
      pickup.setAttribute('aria-pressed', pinningEnd === 'pickup' ? 'true' : 'false');
      pickup.textContent = smartPinLabel();
    }
    if (drop) {
      drop.setAttribute('aria-pressed', pinningEnd === 'drop' ? 'true' : 'false');
      drop.textContent = pinningEnd === 'drop' ? 'Click the map to set your drop' : 'Pin my drop';
    }
    const map = openMaps.get('smartMap');
    if (map) map.setPinMode(Boolean(pinningEnd), applySmartPin);
  }

  function applySmartPin(coordinate) {
    if (!coordinate || !pinningEnd) return;
    const suffix = pinningEnd === 'pickup' ? 'Pickup' : 'Drop';
    const lng = document.getElementById(`smart${suffix}Lng`);
    const lat = document.getElementById(`smart${suffix}Lat`);
    if (lng) lng.value = String(coordinate.lng);
    if (lat) lat.value = String(coordinate.lat);
    const note = document.getElementById('smartNote');
    if (note) note.textContent = `Your ${pinningEnd} is pinned. Search again to match it against the road.`;
    setSmartPin('');
  }

  function smartSearchParams(form) {
    const query = new URLSearchParams();
    const add = (key, value) => { if (value) query.set(key, value); };
    add('from', form.from.value.trim());
    add('to', form.to.value.trim());
    add('date', form.date.value);
    add('vehicleType', form.vehicleType.value);
    const pickupLng = document.getElementById('smartPickupLng')?.value;
    const pickupLat = document.getElementById('smartPickupLat')?.value;
    const dropLng = document.getElementById('smartDropLng')?.value;
    const dropLat = document.getElementById('smartDropLat')?.value;
    if (pickupLng && pickupLat) { add('fromLng', pickupLng); add('fromLat', pickupLat); }
    if (dropLng && dropLat) { add('toLng', dropLng); add('toLat', dropLat); }
    return query;
  }

  async function runSmartSearch(form, results) {
    const panel = document.getElementById('smartPanel');
    const rejected = document.getElementById('smartRejected');
    if (panel) panel.hidden = false;
    results.innerHTML = '<div class="rvx-grid"><div class="rvx-skeleton" style="height:280px"></div><div class="rvx-skeleton" style="height:280px"></div></div>';
    const query = smartSearchParams(form);
    const map = await routeMap('smartMap', { ariaLabel: 'Your journey, and the rides that drive the same road', interactive: true });

    let data;
    try {
      data = await api(`/rides/smart-search?${query.toString()}`);
    } catch (error) {
      results.innerHTML = `<div class="rvx-empty"><h3>Rides on that road could not be loaded</h3><p>${escapeHtml(error.message)}</p></div>`;
      return;
    }

    // The rider's own road is drawn first, so the offer roads sit on top of it.
    if (map) {
      map.setJourney({
        geometry: data.route?.geometry,
        provider: data.route?.provider || data.roadDataSource,
        estimated: data.route?.estimated,
        originName: data.route?.from,
        destinationName: data.route?.to
      });
      // The rider's OWN road is labelled here, so the map answers "what towns do
      // I pass" before any offer is even picked.
      map.setCheckpoints(data.route?.checkpoints || null);
      if (pinningEnd) map.setPinMode(true, applySmartPin);
    }
    await renderRides(data.matches, results);

    if (rejected) {
      const lines = (data.rejected || []).map(entry => `${entry.from} to ${entry.to}: ${entry.message}`);
      rejected.hidden = !lines.length;
      rejected.textContent = lines.length
        ? `Checked ${data.consideredCount} live offers. Not on your road: ${lines.join(' ')}`
        : '';
    }
    const note = document.getElementById('smartNote');
    if (note && !pinningEnd) {
      const source = data.roadDataSource === 'mapbox'
        ? 'Real road geometry from Mapbox.'
        : (data.roadDataSource === 'osrm'
          ? 'Real road geometry from the key-free public OSRM service, because no Mapbox key is configured.'
          : 'Straight-line estimates, because no road-routing provider is available.');
      note.textContent = data.matchCount
        ? `${data.matchCount} of ${data.consideredCount} live offers drive your road. ${source}`
        : `None of the ${data.consideredCount} live offers drive your road. ${source}`;
    }
  }

  /**
   * The Smart Route panel on a match card.
   *
   * It answers the three things a rider asks before booking a ride they did not
   * search for by name: where do I get on, where do I get off, and what does that
   * part of the road cost. Without those three numbers a mid-route offer looks
   * like a mistake, which is exactly why it is shown and not hidden.
   */
  function matchBlock(ride) {
    const match = ride.match;
    if (!match || !match.ok) return '';
    const smart = ride.quote?.smart || {};
    const full = match.mode === 'full';
    const detour = Math.round(((Number(match.pickupDetourKm) || 0) + (Number(match.dropDetourKm) || 0)) * 10) / 10;
    const stat = (label, value, extra) => `<div class="rvx-match__stat"><dt>${escapeHtml(label)}</dt><dd${extra ? ` class="${extra}"` : ''}>${escapeHtml(value)}</dd></div>`;
    return `
      <div class="rvx-match${full ? ' rvx-match--full' : ''}">
        <div class="rvx-match__head">
          <p class="rvx-match__label">${escapeHtml(full ? 'Covers your whole journey' : 'Joins this ride part-way')}</p>
          ${smart.savedTotal > 0 ? `<span class="rvx-match__save">You save ${formatMoney(smart.savedTotal)}</span>` : ''}
        </div>
        <p class="rvx-smart__note">${escapeHtml(match.message || '')}</p>
        <dl class="rvx-match__grid">
          ${stat('Your leg', `${match.riderKm} of ${match.totalKm} km`)}
          ${stat('Board at', `${match.board?.name || 'your pickup point'}${Number(match.board?.alongKm) > 0 ? ` · ${match.board.alongKm} km along` : ''}`)}
          ${stat('Leave at', match.drop?.name || 'your drop point')}
          ${detour > 0 ? stat('Driver detour', `${detour} km`) : ''}
          ${stat('Fare per seat', formatMoney(smart.farePerSeat ?? ride.price))}
        </dl>
        ${full ? '' : checkpointStrip(match.checkpoints || quote.smart?.checkpoints)}
      </div>`;
  }

  function rideCard(ride) {
    const quote = ride.quote || {};
    const total = Number(quote.grandTotal ?? ride.price ?? 0);
    const bookable = ride.bookable && !ride.soldOut;
    const smart = quote.smart || {};
    const seats = Number(quote.seats) || 1;
    const unit = smart.applied ? `total for ${seats} seat${seats > 1 ? 's' : ''}` : 'total for 1 seat';
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
            ${routeChips(ride.route)}
          </div>

          ${matchBlock(ride)}

          <div class="rvx-user">
            ${imageOrInitials(ride.driverPhoto, ride.driver, { className: 'rvx-user-avatar', alt: '' })}
            <span style="min-width:0">
              <span class="rvx-user__name">${escapeHtml(ride.driver || 'REVEX driver')}</span>
              <span class="rvx-user__sub">★ ${Number(ride.rating || 5).toFixed(1)} · ${escapeHtml(ride.vehicleType || 'Car')}</span>
            </span>
          </div>

          <div class="rvx-price rvx-price--total">
            <span class="rvx-price__amount">${formatMoney(total)}</span>
            <span class="rvx-price__unit">${escapeHtml(unit)}</span>
            <span class="rvx-price__unit" style="margin-left:auto">${smart.applied
              ? `${formatMoney(smart.farePerSeat)} per seat for your part of the road`
              : `${formatMoney(ride.price)} per seat`}</span>
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

  /**
   * Turns the "pin my pickup" / "pin my drop" buttons on or off.
   *
   * `end` is 'pickup', 'drop', or falsy for neither. The two are mutually
   * exclusive on purpose: one map click has to mean one thing, and a rider who
   * presses the second button has changed their mind about which end they are
   * placing, not asked to place both at once.
   */
  function setJoinPinMode(end) {
    const wanted = end || '';
    for (const [id, label] of [['joinPinBtn', 'pickup'], ['joinDropPinBtn', 'drop']]) {
      const button = document.getElementById(id);
      if (!button) continue;
      const on = wanted === label;
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.textContent = on
        ? `Click the map to set your ${label}`
        : `Pin my ${label} on the map`;
    }
    const map = openMaps.get('rideMap');
    if (map) map.setPinMode(Boolean(wanted), applyJoinPin);
  }

  /**
   * A pin dropped on the map is sent to the server as a COORDINATE, never as a
   * place name. The server snaps it to the nearest point on the ride's real road,
   * so a rider who taps roughly at Rajkot boards at Rajkot and not at whichever
   * building their finger happened to land on.
   */
  function applyJoinPin(coordinate) {
    if (!coordinate || !joiningEnd) return;
    const suffix = joiningEnd === 'drop' ? 'Drop' : 'Pickup';
    const lng = document.getElementById(`join${suffix}Lng`);
    const lat = document.getElementById(`join${suffix}Lat`);
    if (lng) lng.value = String(coordinate.lng);
    if (lat) lat.value = String(coordinate.lat);
    // A pin is a statement about a point, so it replaces the typed name for that
    // end. Leaving both would show the rider a box that says one place and a map
    // pin sitting somewhere else, and they would not know which one is charged for.
    const box = document.getElementById(joiningEnd === 'drop' ? 'joinTo' : 'joinFrom');
    if (box) box.value = '';
    joiningEnd = '';
    setJoinPinMode('');
    refreshJoin().then(() => refreshQuote()).catch(() => { /* the message box already says why */ });
  }

  /**
   * Redraws the road with the rider's leg on it, and states whether the join is
   * possible at all.
   *
   * The verdict comes from the SERVER, from the same plan the quote uses, so the
   * map can never show "you can join here" next to a price that disagrees.
   */
  async function refreshJoin() {
    const box = document.getElementById('rideJoin');
    if (!box || !currentRideId) return null;
    const message = document.getElementById('joinMsg');
    const map = await routeMap('rideMap', { ariaLabel: 'The road this ride drives, and where you would join it' });
    const points = joinPoints('join');
    const suffix = withJoinPoints(new URLSearchParams(), points).toString();
    try {
      const data = await api(`/rides/${encodeURIComponent(currentRideId)}/route${suffix ? `?${suffix}` : ''}`);
      const route = data.route || {};
      if (map) {
        map.setRoute({ geometry: route.geometry, provider: route.provider, estimated: route.estimated, origin: route.origin, destination: route.destination, originName: route.from, destinationName: route.to });
      }
      const match = data.match;
      if (map) {
        if (match?.ok) map.setLegs(match.legs || {}).setMatch(match);
        else map.setLegs({}).setMatch(null);
        // A joined leg shows only what is on the RIDER's leg; the whole-route
        // checkpoints are the fallback when they are taking the whole road.
        map.setCheckpoints(match?.ok ? (match.checkpoints || null) : (route.checkpoints || null));
      }
      box.hidden = !(route.geometry?.length || match);
      if (!match) {
        if (message) {
          message.className = 'rvx-join__msg';
          message.textContent = route.geometry?.length
            ? 'Leave both boxes empty to travel the whole route at the full price. You can pin either end of your journey, and a pin always wins over the box beside it.'
            : (route.error || 'The road route for this ride is not available yet, so joining part-way is switched off for it.');
        }
      } else if (match.ok) {
        if (message) {
          message.className = 'rvx-join__msg rvx-join__msg--good';
          message.textContent = `${match.message} You travel ${match.riderKm} km of this ${match.totalKm} km road.`;
        }
      } else if (message) {
        message.className = 'rvx-join__msg rvx-join__msg--bad';
        message.textContent = match.message;
      }
      // Re-asserted after every redraw so a re-render cannot quietly leave the
      // map in pin mode with no button showing it, which would make the next
      // click place a pin the rider cannot account for.
      if (map) map.setPinMode(Boolean(joiningEnd), applyJoinPin);
      return match;
    } catch (error) {
      if (message) {
        message.className = 'rvx-join__msg rvx-join__msg--bad';
        message.textContent = error.message;
      }
      return null;
    }
  }

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
    // With no join points this is exactly the request this screen always made,
    // so the full-route behaviour is untouched. With points, the server prices
    // the part of the road the rider actually travels.
    const query = withJoinPoints(new URLSearchParams(), joinPoints('join'));
    const suffix = query.toString();
    currentQuote = await api(`/rides/${encodeURIComponent(currentRideId)}/quote?seats=${seats}${suffix ? `&${suffix}` : ''}`);
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
    if (submit) submit.dataset.bookable = currentQuote.bookable ? 'true' : 'false';
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
            ${routeChips(item.route)}
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

      // The road, and whether this rider can join it part-way, before any price
      // is shown. `refreshJoin` is what enables the join box; it stays hidden
      // until the server confirms the ride actually has a road.
      const joinBox = document.getElementById('rideJoin');
      if (joinBox) {
        // Carry the rider's own journey over from the page they came from.
        //
        // Without this the search is silently lost at the last step: Find Ride
        // says "you join at Rajkot, 104.8 km along, ₹536.80 a seat", the rider
        // taps the card, and this page shows the full-route ₹935 with an empty
        // join box. A price that goes UP on the way to payment is the one thing
        // that makes a rider distrust the whole feature, so the points are
        // restored before the first quote is ever requested.
        const carried = new URLSearchParams(location.search);
        const carriedFrom = String(carried.get('from') || '').trim();
        const carriedTo = String(carried.get('to') || '').trim();
        // The presence test comes BEFORE the number test, deliberately:
        // `Number(null)` is 0, which is a finite number, so a link with no pin on
        // it would be read as a pin at 0,0 - null island, in the middle of the
        // Atlantic - and every join on the page would be refused with a location
        // error. The rider would have no idea why.
        const hasPinParams = carried.has('pickupLng') && carried.has('pickupLat');
        const carriedLng = Number(carried.get('pickupLng'));
        const carriedLat = Number(carried.get('pickupLat'));
        const hasPin = hasPinParams && Number.isFinite(carriedLng) && Number.isFinite(carriedLat);
        if (carriedFrom) {
          const field = document.getElementById('joinFrom');
          if (field) field.value = carriedFrom;
        }
        if (hasPin) {
          const lng = document.getElementById('joinPickupLng');
          const lat = document.getElementById('joinPickupLat');
          if (lng) lng.value = String(carriedLng);
          if (lat) lat.value = String(carriedLat);
        }
        if (carriedTo) {
          const field = document.getElementById('joinTo');
          if (field) field.value = carriedTo;
        }
        if (carriedFrom || carriedTo || hasPin) {
          const title = document.getElementById('rideJoinTitle');
          if (title) title.textContent = hasPin
            ? 'Your pickup point, kept from your search'
            : 'Your journey, kept from your search';
        }
        const schedule = () => {
          clearTimeout(joinTimer);
          joinTimer = setTimeout(() => {
            refreshJoin().then(() => refreshQuote()).catch(error => showToast(error.message, 'bad'));
          }, 450);
        };
        document.getElementById('joinFrom')?.addEventListener('input', schedule);
        document.getElementById('joinTo')?.addEventListener('input', schedule);
        // One click arms the map, the next disarms it - and pressing the other
        // button while one is armed switches ends rather than arming both.
        for (const [id, label] of [['joinPinBtn', 'pickup'], ['joinDropPinBtn', 'drop']]) {
          document.getElementById(id)?.addEventListener('click', () => {
            const next = joiningEnd === label ? '' : label;
            joiningEnd = next;
            setJoinPinMode(next);
          });
        }
        document.getElementById('joinClearBtn')?.addEventListener('click', () => {
          ['joinFrom', 'joinTo', 'joinPickupLng', 'joinPickupLat', 'joinDropLng', 'joinDropLat'].forEach(id => {
            const field = document.getElementById(id);
            if (field) field.value = '';
          });
          joiningEnd = '';
          setJoinPinMode('');
          refreshJoin().then(() => refreshQuote()).catch(() => { /* the message box already says why */ });
        });
      }
      await refreshJoin();
      await refreshQuote();
      if (location.hash === '#book') document.querySelector('#rideBookBtn button')?.focus();
    } catch (error) {
      panel.innerHTML = `<div class="rvx-empty"><h3>Ride unavailable</h3><p>${escapeHtml(error.message)}</p><a class="rvx-btn rvx-btn--outline" href="find-ride.html">Back to Find a Ride</a></div>`;
    }
  }

  async function confirmRide(event) {
    event.preventDefault();
    if (!requireLogin() || !currentRideId) throw new Error('Please sign in before booking this ride.');
    const terms = document.getElementById('rideTerms');
    if (terms && !terms.checked) { showToast('Accept the ride sharing terms before booking.', 'warn'); terms.focus(); throw new Error('Accept the ride sharing terms before booking.'); }
    if (!document.getElementById('seatCount')?.checkValidity?.()) throw new Error('Choose a valid number of seats.');

    let booking;
    let config;
    try {
      // The rider's join points are sent so the SERVER can re-derive the plan and
      // the price. Nothing the browser sends is trusted as an amount.
      const payload = joinPayload({ seats: Number(document.getElementById('seatCount')?.value) || 1, termsAccepted: true }, joinPoints('join'));
      booking = await api(`/rides/${encodeURIComponent(currentRideId)}/book`, {
        method: 'POST',
        body: payload
      });
      config = await global.RevexPay.getConfig();
    } catch (error) { showToast(error.message, 'bad', 8000); throw error; }

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
      throw new Error('Payment was cancelled.');
    } else {
      dialog.close();
      await loadRideDetail(currentRideId);
      throw new Error('Payment could not be completed.');
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
    event?.preventDefault?.();
    const form = event.target;
    if (!requireRole('owner', 'admin')) throw new Error('Owner access is required to submit a ride offer.');
    const terms = form.elements.termsAccepted;
    if (!form.reportValidity()) throw new Error('Please complete all required ride-offer fields.');
    if (terms && !terms.checked) { showToast('Accept the ride sharing terms before submitting.', 'warn'); terms.focus(); throw new Error('Accept the ride sharing terms before submitting.'); }

    const submit = null;

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

    }
  }

  /* ------------------------------------------------- 4. OFFER ROUTE PREVIEW */

  /**
   * Shows the owner the real road they are about to publish, while they are still
   * typing, instead of after they submit and discover the route goes somewhere
   * they did not intend. It costs one cached routing call per pause in typing and
   * stores nothing.
   */
  async function previewOfferRoute(form) {
    const message = document.getElementById('offerRouteMsg');
    const from = form.from.value.trim();
    const to = form.to.value.trim();
    const map = openMaps.get('offerRouteMap');
    if (!from || !to) {
      map?.clear();
      if (message) {
        message.className = 'rvx-join__msg';
        message.textContent = 'Type a starting town and a destination to see the real road, the towns it passes through, and how far it is.';
      }
      return;
    }
    if (message) { message.className = 'rvx-join__msg'; message.textContent = 'Working out the road…'; }
    try {
      const data = await api(`/rides/route-preview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (!data.ok) {
        map?.clear();
        if (message) { message.className = 'rvx-join__msg rvx-join__msg--bad'; message.textContent = data.message || 'That road could not be found.'; }
        return;
      }
      const live = await routeMap('offerRouteMap', { ariaLabel: 'The road this offer will publish' });
      live?.setRoute({
        geometry: data.geometry,
        provider: data.provider,
        estimated: data.estimated,
        origin: data.origin,
        destination: data.destination,
        originName: from,
        destinationName: to
      });
      // An owner publishing a route is publishing the towns it passes, so they
      // are shown here too rather than only to riders.
      live?.setCheckpoints(data.checkpoints || { towns: (data.via || []).filter(entry => entry && entry.name) });
      const via = (data.via || []).map(entry => entry?.name).filter(Boolean);
      const hours = Math.floor((Number(data.durationMin) || 0) / 60);
      const rest = (Number(data.durationMin) || 0) % 60;
      const duration = hours ? (rest ? `about ${hours} h ${rest} m` : `about ${hours} h`) : (rest ? `about ${rest} m` : '');
      if (message) {
        message.className = 'rvx-join__msg rvx-join__msg--good';
        message.textContent = `${data.distanceKm} km${duration ? `, ${duration}` : ''}${via.length ? `, via ${via.join(', ')}` : ''}. Riders searching any town along that road can join part-way.`;
      }
      // The road distance is more accurate than anything the owner can type, so
      // the field is only overwritten while it is still empty.
      const distance = form.elements.distanceKm;
      if (distance && !distance.value && Number(data.distanceKm) > 0) distance.value = String(Math.round(data.distanceKm));
    } catch (error) {
      if (message) { message.className = 'rvx-join__msg rvx-join__msg--bad'; message.textContent = error.message; }
    }
  }

  /* ----------------------------------------------------------------- boot */
  window.RevexLoadingActions = window.RevexLoadingActions || {};
  window.RevexLoadingActions.offerRide = () => {
    const form = document.getElementById('offerRide');
    if (!form) throw new Error('Ride offer form is not available.');
    return handleOfferSubmit({ preventDefault() {}, target: form });
  };
  window.RevexLoadingActions.rideBook = () => {
    const form = document.getElementById('rideBookForm');
    if (!form) throw new Error('Ride booking form is not available.');
    return confirmRide({ preventDefault() {}, target: form });
  };

  document.addEventListener('DOMContentLoaded', () => {
    const results = document.getElementById('rideResults');
    if (results) {
      const search = document.getElementById('rideSearch');
      const panel = document.getElementById('smartPanel');
      const toggle = document.getElementById('rideSmartMode');
      const skeleton = '<div class="rvx-grid"><div class="rvx-skeleton" style="height:280px"></div><div class="rvx-skeleton" style="height:280px"></div><div class="rvx-skeleton" style="height:280px"></div></div>';

      // The ORIGINAL list search, unchanged: same endpoint, same request, same
      // rendering. It is still the path taken whenever Smart Route is off or the
      // rider has not said where they are going.
      const run = async params => {
        if (panel) panel.hidden = true;
        results.innerHTML = skeleton;
        try { await renderRides(await getRides(params), results); }
        catch (error) { results.innerHTML = `<div class="rvx-empty"><h3>Rides could not be loaded</h3><p>${escapeHtml(error.message)}</p></div>`; }
      };

      /** Smart Route only makes sense with somewhere to start from. */
      const smartIsOn = () => Boolean(toggle && toggle.checked && search
        && (search.from.value.trim() || search.to.value.trim()
          || document.getElementById('smartPickupLng')?.value));

      const searchNow = async () => {
        if (!search) return;
        if (smartIsOn()) return runSmartSearch(search, results);
        return run({ from: search.from.value, to: search.to.value, date: search.date.value, vehicleType: search.vehicleType.value });
      };

      run({});
      search?.addEventListener('submit', event => {
        event.preventDefault();
        searchNow().catch(error => showToast(error.message, 'bad'));
      });
      toggle?.addEventListener('change', () => {
        setSmartPin('');
        searchNow().catch(error => showToast(error.message, 'bad'));
      });
      document.getElementById('smartPinPickup')?.addEventListener('click', () => setSmartPin('pickup'));
      document.getElementById('smartPinDrop')?.addEventListener('click', () => setSmartPin('drop'));
      document.getElementById('smartPinClear')?.addEventListener('click', () => {
        ['smartPickupLng', 'smartPickupLat', 'smartDropLng', 'smartDropLat'].forEach(id => {
          const field = document.getElementById(id);
          if (field) field.value = '';
        });
        setSmartPin('');
        const note = document.getElementById('smartNote');
        if (note) note.textContent = 'Rides that drive the same road are matched by distance, not by name, so a Junagadh to Ahmedabad offer also shows up for Rajkot to Ahmedabad.';
        searchNow().catch(() => { /* the results box already says why */ });
      });
      const clear = document.getElementById('rideSearchReset');
      clear?.addEventListener('click', () => {
        setSmartPin('');
        if (search) search.reset();
        const note = document.getElementById('smartNote');
        if (note) note.textContent = 'Rides that drive the same road are matched by distance, not by name, so a Junagadh to Ahmedabad offer also shows up for Rajkot to Ahmedabad.';
        run({});
      });
    }

    const offer = document.getElementById('offerRide');
    if (offer) {
      populateVehiclePicker(offer).catch(error => showToast(error.message, 'bad'));
      offer.addEventListener('submit', event => { handleOfferSubmit(event).catch(() => {}); });
      // A date picker that defaults to today cannot produce a valid offer.
      const date = offer.elements.date;
      if (date && !date.value) {
        const tomorrow = new Date(Date.now() + 86400000);
        date.value = tomorrow.toISOString().slice(0, 10);
        date.min = new Date().toISOString().slice(0, 10);
      }
      if (document.getElementById('offerRouteMap')) {
        // Debounced so a town name is routed once the rider pauses, not per keystroke.
        let previewTimer = null;
        const schedule = () => {
          clearTimeout(previewTimer);
          previewTimer = setTimeout(() => previewOfferRoute(offer), 700);
        };
        offer.from?.addEventListener('input', schedule);
        offer.to?.addEventListener('input', schedule);
      }
    }

    const bookForm = document.getElementById('rideBookForm');
    if (bookForm) {
      bookForm.addEventListener('submit', event => { confirmRide(event).catch(() => {}); });
      loadRideDetail(new URLSearchParams(location.search).get('id'));
    }
  });

  global.RevexRides = { getRides, refreshQuote };
})(window);

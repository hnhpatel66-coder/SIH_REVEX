let currentRideId = '';
let currentRide = null;

function rideImage(ride) {
  const image = assetUrl(ride.vehicleImage || '');
  const fallback = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420"><rect width="100%" height="100%" fill="#12333a"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="28" fill="#cbd5e1">REVEX Ride</text></svg>')}`;
  return image ? `<div class="ride-image"><img src="${escapeHtml(image)}" alt="${escapeHtml(ride.vehicle || 'Ride vehicle')}" onerror="this.onerror=null;this.src='${fallback}'"></div>` : `<div class="ride-image"><img src="${fallback}" alt="REVEX Ride vehicle"></div>`;
}
function rideCard(ride) {
  return `<article class="ride-card">${rideImage(ride)}<div class="card-top"><div><span class="badge badge-category">${escapeHtml(ride.vehicleType || 'Other').toUpperCase()}</span><h3 class="ride-route">${escapeHtml(ride.from)} <span class="route-arrow">→</span> ${escapeHtml(ride.to)}</h3></div><span class="star-rating">★ ${Number(ride.rating || 5).toFixed(1)}</span></div><p class="card-meta">Driver: <b>${escapeHtml(ride.driver || 'REVEX driver')}</b> · ${escapeHtml(ride.vehicle || 'Vehicle')}</p><div class="vehicle-facts"><span>${escapeHtml(ride.fuelType || 'Petrol')}</span><span>${ride.seats} seats</span><span>${escapeHtml(ride.numberPlate || 'Plate listed at pickup')}</span></div><div class="ride-details"><div><b>Departure</b>${formatDate(ride.date)} · ${escapeHtml(ride.time || '')}</div><div><b>Price</b>${formatMoney(ride.price)} / person</div></div><div class="card-actions"><a class="btn btn-outline" href="ride-details.html?id=${encodeURIComponent(ride.id)}">View ride</a><a class="btn btn-primary" href="ride-details.html?id=${encodeURIComponent(ride.id)}">Book seat</a></div></article>`;
}
async function getRides(params = {}) { const query = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value) query.set(key, value); }); return api(`/rides?${query.toString()}`); }
async function renderRides(rides) { const box = document.getElementById('rideResults'); if (box) box.innerHTML = rides?.length ? rides.map(rideCard).join('') : '<div class="empty">No matching approved rides. New offers appear after admin approval.</div>'; }
function fileToDataUrl(file, maxMb = 3) {
  return new Promise((resolve, reject) => { if (!file) return resolve(''); if (file.size > maxMb * 1024 * 1024) return reject(new Error(`Photo must be smaller than ${maxMb} MB.`)); const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read the selected photo.')); reader.readAsDataURL(file); });
}
async function loadRideDetail(id) {
  const panel = document.getElementById('rideDetail'); if (!panel) return;
  try {
    let rides = await getRides(); let item = rides.find(ride => ride.id === id);
    if (!item && getStoredUser()?.role === 'owner') { try { item = (await api('/rides/mine')).find(ride => ride.id === id); } catch {} }
    if (!item) throw new Error('Ride not found or it is still awaiting approval.');
    currentRide = item; currentRideId = id;
    panel.innerHTML = `${rideImage(item)}<div class="badge-row"><span class="badge badge-category">${escapeHtml(item.vehicleType || 'Other').toUpperCase()}</span><span class="badge badge-fuel">${escapeHtml(item.fuelType || 'Petrol').toUpperCase()}</span><span class="pill">${item.verified ? 'Available' : 'Pending approval'}</span></div><h1 class="section-title">${escapeHtml(item.from)} <span class="route-arrow">→</span> ${escapeHtml(item.to)}</h1><p>Travel with ${escapeHtml(item.driver || 'a REVEX driver')} in ${escapeHtml(item.vehicle || 'a verified vehicle')}.</p><div class="detail-facts"><div><b>Departure</b>${formatDate(item.date)} · ${escapeHtml(item.time || '')}</div><div><b>Seats</b>${item.seats}</div><div><b>Number plate</b>${escapeHtml(item.numberPlate || '-')}</div><div><b>Driver contact</b>${escapeHtml(item.driverPhone || 'Available after booking')}</div></div>`;
    const price = document.getElementById('ridePrice'); if (price) price.value = Number(item.price) || 0;
    const seats = document.getElementById('seatCount'); if (seats) seats.innerHTML = Array.from({ length: Math.max(1, Math.min(6, Number(item.seats) || 1)) }, (_, index) => `<option value="${index + 1}">${index + 1} seat${index ? 's' : ''}</option>`).join('');
    document.getElementById('availableSeats').textContent = item.seats; updateSeatTotal();
  } catch (error) { panel.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}
function updateSeatTotal() { const seats = Number(document.getElementById('seatCount')?.value) || 1; const price = Number(document.getElementById('ridePrice')?.value) || 0; const total = seats * price; const label = document.getElementById('seatTotal'); const pay = document.getElementById('ridePayAmount'); if (label) label.textContent = formatMoney(total); if (pay) pay.textContent = formatMoney(total); }
async function confirmRide(event) {
  event.preventDefault(); if (!requireLogin() || !currentRideId) return;
  const seats = Number(document.getElementById('seatCount')?.value) || 1; const total = seats * Number(document.getElementById('ridePrice')?.value || 0);
  if (total <= 0) return alert('Ride price is unavailable.');
  let booking;
  try { booking = await api(`/rides/${encodeURIComponent(currentRideId)}/book`, { method: 'POST', body: { seats } }); } catch (error) { alert(error.message); return; }
  const modal = document.getElementById('paymentModal'); modal?.classList.add('show'); document.getElementById('ridePayAmount').textContent = formatMoney(total);
  const pay = document.getElementById('ridePayBtn'); const cancel = document.getElementById('ridePayCancel');
  const markPaymentFailed = async () => { try { await api(`/rides/bookings/${encodeURIComponent(booking.id)}/payment-failed`, { method: 'POST' }); } catch {} };
  pay.onclick = async () => {
    pay.disabled = true; pay.textContent = 'Opening Razorpay…';
    try {
      if (typeof window.Razorpay !== 'function') throw new Error('Razorpay Checkout failed to load. Check your internet connection and try again.');
      const order = await api(`/rides/bookings/${encodeURIComponent(booking.id)}/payment-order`, { method: 'POST' });
      if (!order?.order_id || !order?.key_id || !order?.amount || !order?.currency) throw new Error('The Razorpay order response is incomplete.');
      const user = getStoredUser?.() || {};
      let checkoutFinished = false;
      const razorpay = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        order_id: order.order_id,
        name: 'REVEX',
        description: `${currentRide?.from || 'Ride'} to ${currentRide?.to || 'destination'}`,
        prefill: { name: user.name || '', email: user.email || '', contact: user.phone || '' },
        theme: { color: '#0f8f83' },
        modal: {
          ondismiss: async () => {
            if (checkoutFinished) return;
            checkoutFinished = true;
            modal.classList.remove('show');
            await markPaymentFailed();
            showModal('Payment cancelled', 'The Razorpay checkout was closed. Your ride booking was not confirmed.');
          }
        },
        handler: async response => {
          if (checkoutFinished) return;
          checkoutFinished = true;
          try {
            const result = await api(`/rides/bookings/${encodeURIComponent(booking.id)}/verify-payment`, {
              method: 'POST',
              body: {
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature
              }
            });
            modal.classList.remove('show');
            showModal('Ride booked successfully', `${formatMoney(total)} paid via Razorpay. Your seat is confirmed.`);
          } catch (error) {
            modal.classList.remove('show');
            showModal('Payment verification failed', error.message || 'We could not verify this Razorpay payment.');
          }
        }
      });
      razorpay.on('payment.failed', async response => {
        if (checkoutFinished) return;
        checkoutFinished = true;
        modal.classList.remove('show');
        await markPaymentFailed();
        showModal('Payment failed', response?.error?.description || 'The Razorpay payment could not be completed.');
      });
      razorpay.open();
    } catch (error) {
      alert(error.message || 'Unable to start Razorpay payment.');
    } finally {
      pay.disabled = false; pay.textContent = 'Pay Now';
    }
  };
  cancel.onclick = async () => { modal.classList.remove('show'); await markPaymentFailed(); };
}
document.addEventListener('DOMContentLoaded', async () => {
  const search = document.getElementById('rideSearch');
  if (document.getElementById('rideResults')) { try { await renderRides(await getRides()); } catch (error) { document.getElementById('rideResults').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; } search?.addEventListener('submit', async event => { event.preventDefault(); try { await renderRides(await getRides({ from: search.from.value, to: search.to.value, date: search.date.value, vehicleType: search.vehicleType.value })); } catch (error) { alert(error.message); } }); }
  const offer = document.getElementById('offerRide');
  offer?.addEventListener('submit', async event => { event.preventDefault(); if (!requireRole('owner', 'admin')) return; const form = event.target; const submit = form.querySelector('button[type="submit"]'); submit.disabled = true; try { const vehicleImage = await fileToDataUrl(form.vehicleImage?.files?.[0]); const ride = await api('/rides', { method: 'POST', body: { from: form.from.value.trim(), to: form.to.value.trim(), date: form.date.value, time: form.time.value, seats: Number(form.seats.value), price: Number(form.price.value), vehicle: form.vehicle.value.trim(), vehicleType: form.vehicleType.value, fuelType: form.fuelType?.value || 'Petrol', numberPlate: form.numberPlate.value.trim(), driverPhone: form.driverPhone.value.trim(), vehicleImage } }); showModal('Ride submitted', ride.message || 'Your offer is pending admin approval.'); form.reset(); } catch (error) { alert(error.message); } finally { submit.disabled = false; } });
  if (document.getElementById('rideDetail')) await loadRideDetail(new URLSearchParams(location.search).get('id'));
});

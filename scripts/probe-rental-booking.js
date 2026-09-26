/**
 * Drive the whole rental booking flow end to end, as the form does.
 *   node scripts/probe-rental-booking.js
 * Registers a throwaway renter, books the vehicle, pays (test mode), and
 * reports every step. Prints the ids it created so they can be removed.
 */
'use strict';

const BASE = 'http://localhost:5001/api';
const VEHICLE_ID = process.argv[2];
const stamp = Date.now();
let token = '';

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const show = (label, r) => {
  const ok = r.status >= 200 && r.status < 300;
  console.log(`  ${r.status}  ${label}`);
  if (!ok) console.log(`        -> "${r.data.message || JSON.stringify(r.data).slice(0, 160)}"`);
  return ok;
};

(async () => {
  if (!VEHICLE_ID) { console.error('Pass the vehicle id: node scripts/probe-rental-booking.js <id>'); process.exit(1); }

  const reg = await call('/auth/register', { method: 'POST', auth: false, body: { name: 'Booking Probe', email: `bookprobe${stamp}@revex.test`, phone: '9999999993', password: 'Probe!Pass123' } });
  token = reg.data.token;
  console.log('renter registered:', reg.status, reg.data.user?.role || '');
  if (!token) { console.log('   ', reg.data.message); return; }

  const body = {
    vehicleId: VEHICLE_ID,
    startDate: '2026-09-28T05:45',
    endDate: '2026-09-30T00:00',
    estimatedKm: 452,
    panNumber: 'ABCDW1234P',
    drivingLicenseNumber: 'GJ11SVP78945',
    agreementAccepted: true,
    termsVersion: 'revex-v3'
  };

  console.log('\n=== POST /api/bookings  (the window from the bug report) ===');
  const created = await call('/bookings', { method: 'POST', body });
  show('booking created', created);
  if (created.status >= 300) { console.log('\nSTOPPED: the booking itself failed.'); return; }

  const id = created.data.id || created.data.bookingId || created.data._id;
  const quote = created.data.quote || created.data.pricing || {};
  console.log(`        id            : ${id}`);
  console.log(`        status        : ${created.data.status}`);
  console.log(`        total         : ${created.data.totalAmount ?? created.data.grandTotal}`);
  console.log(`        quote.total   : ${quote.grandTotal}`);
  console.log(`        agreement     : ${created.data.agreement?.agreementId || 'none'}`);

  console.log('\n=== the payment step (test mode, since Razorpay keys are rejected) ===');
  const cfg = await call('/payments/config', { auth: false });
  console.log(`  gateway usable: ${cfg.data.usable} (state=${cfg.data.state})`);
  const paid = await call(`/bookings/${id}/payment-test`, { method: 'POST', body: {} });
  show('test payment recorded', paid);
  console.log(`        status        : ${paid.data.booking?.status}`);
  console.log(`        paymentStatus : ${paid.data.booking?.paymentStatus}`);
  console.log(`        paymentMethod : ${paid.data.booking?.paymentMethod}`);

  console.log('\n=== does it show up in My Bookings? ===');
  const mine = await call('/bookings/my');
  console.log(`  ${mine.status}  ${Array.isArray(mine.data) ? mine.data.length : '?'} booking(s)`);
  (Array.isArray(mine.data) ? mine.data : []).forEach(b => console.log(`        ${b.id}  ${b.status}  ${b.startDate} -> ${b.endDate}`));

  console.log(`\ncreated booking ${id} (delete it to clean up)`);
})().catch(e => { console.error('probe failed:', e.message); process.exit(1); });

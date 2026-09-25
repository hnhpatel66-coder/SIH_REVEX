/* ============================================================================
 * CENTRALISED API CONFIGURATION  (js/main.js is loaded by every page)
 *
 * ROOT CAUSE OF THE "Create Account fails" BUG:
 * this used to be a hard-coded relative `const API_BASE = '/api'`. A relative
 * URL only resolves correctly when the HTML file is served by the SAME Express
 * process that serves /api. Open register.html from VS Code Live Server, a
 * Live Preview tab, a Vite dev server or any other origin and the browser
 * requests <that-origin>/api/auth/register, which never reaches the backend.
 * The page still looked fine, so the failure only appeared at the moment the
 * user submitted the form — a generic "Registration failed".
 *
 * Resolution order (first match wins):
 *   1. <meta name="revex-api-base" content="...">   per-page override
 *   2. window.REVEX_API_BASE                        set before main.js loads
 *   3. '/api'                                       same-origin. The API also
 *                                                    serves these pages, so this
 *                                                    is always right in production
 *   4. http://<local-host>:5001/api                 ONLY when a local dev server
 *                                                    (Live Server, Vite) served it
 * ========================================================================== */
const REVEX_DEFAULT_API_PORT = 5001;
const REVEX_API_PORTS = ['5000', String(REVEX_DEFAULT_API_PORT)];

// Hosts that mean "a developer opened this file from a different local server".
// Anything else is a real deployment, where the API is same-origin.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];

function resolveApiBase() {
  const override = (document.querySelector('meta[name="revex-api-base"]') || {}).content || window.REVEX_API_BASE;
  if (override && String(override).trim()) return String(override).trim().replace(/\/+$/, '');
  // No explicit port (proxied deployment) or a known API port => same-origin.
  if (!location.port || REVEX_API_PORTS.includes(location.port)) return '/api';
  // A real deployment is proxied on a port we do not control. Never point it at
  // :5001 there, or every API call would fail in production.
  if (!LOCAL_HOSTS.includes(location.hostname)) return '/api';
  // Only a LOCAL dev server on an unrelated port needs an absolute URL.
  return `${location.protocol}//${location.hostname}:${REVEX_DEFAULT_API_PORT}/api`;
}
const API_BASE = resolveApiBase();
const BRAND = 'REVEX';
const CURRENCY = 'INR';

function readStored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function getStoredUser() { try { return JSON.parse(readStored('revexUser') || readStored('vroomyUser') || 'null'); } catch { return null; } }
function getToken() { return readStored('revexToken') || readStored('vroomyToken') || ''; }
function setSession(data) {
  if (!data?.user) return;
  if (data.token) localStorage.setItem('revexToken', data.token);
  localStorage.setItem('revexUser', JSON.stringify(data.user));
  try { localStorage.removeItem('vroomyToken'); localStorage.removeItem('vroomyUser'); } catch {}
}
function clearSession() {
  try { ['revexToken', 'revexUser', 'vroomyToken', 'vroomyUser'].forEach(key => localStorage.removeItem(key)); } catch {}
}
function friendlyError(message, status) {
  const text = String(message || '');
  if (/cast.*objectid|invalid.*object\s?id|invalid vehicle id|invalid booking id|invalid ride/i.test(text)) return 'We could not find that item. Please try again.';
  if (/jwt|token|session|unauthorized|login required|expired/i.test(text) && status !== 403) return 'Your session has expired. Please log in again.';
  if (/mongo|database|server selection|timed out|network/i.test(text)) return 'The service is temporarily unavailable. Please try again.';
  if (/api endpoint/i.test(text)) return 'The requested service endpoint was not found.';
  return text || 'Something went wrong. Please try again.';
}
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
<<<<<<< HEAD
  if (body && !(body instanceof FormData)) {
    // ROOT CAUSE FIX (registration/login/etc. failing):
    // several pages pass an ALREADY stringified body. The old code only set
    // Content-Type when the body was NOT a string, so those requests went out
    // with no content type. Express's express.json() only parses
    // application/json, so req.body arrived as {} and the backend replied
    // "Name, email and password are required." even though the payload was
    // perfectly valid. The content type must be declared for ANY non-FormData
    // body, whether the caller serialised it or not.
    if (typeof body !== 'string') body = JSON.stringify(body);
    const hasContentType = Object.keys(headers).some(key => key.toLowerCase() === 'content-type');
    if (!hasContentType) headers['Content-Type'] = 'application/json';
=======
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    body = JSON.stringify(body); headers['Content-Type'] = 'application/json';
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  }
  const token = getToken(); if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try { response = await fetch(`${API_BASE}${path}`, { ...options, body, headers }); }
<<<<<<< HEAD
  catch (networkError) {
    // Previously this produced a vague "Cannot reach the REVEX service", which
    // hid the real problem (wrong API origin). Surface the actual target.
    console.error(`[REVEX] request failed: ${API_BASE}${path}`, networkError);
    throw new Error(
      `Cannot reach the REVEX backend at ${API_BASE}.\n\n` +
      `This page is served from ${location.origin}, so the API request went to the wrong place.\n\n` +
      `Start the backend (npm start) and make sure it is listening on port ${REVEX_DEFAULT_API_PORT}, ` +
      `or set <meta name="revex-api-base" content="http://localhost:${REVEX_DEFAULT_API_PORT}/api"> in the page head.`
    );
  }
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401 && getToken()) {
    // Expired or revoked session: drop the stale token so the UI does not stay
    // in a half-logged-in state that fails on every subsequent request.
    clearSession();
    if (!/auth\/(login|register|forgot-password|reset-password)/.test(path)) {
      location.replace('login.html?expired=1');
    }
  }
=======
  catch { throw new Error('Cannot reach the REVEX service. Check your connection and try again.'); }
  let data = {};
  try { data = await response.json(); } catch {}
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  if (!response.ok) throw new Error(friendlyError(data.message, response.status));
  return data;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function formatMoney(value) { return `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`; }
function formatDate(value) { try { return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return value || '-'; } }
<<<<<<< HEAD
function assetUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^data:/i.test(text) || /^blob:/i.test(text)) return text;
  const nested = text.match(/https?:\/\/[^/]+\/(?:https?:\/\/[^/]+\/)(.+)$/i);
  const clean = nested ? nested[1] : text;
  if (/^https?:\/\//i.test(clean)) { try { const url = new URL(clean, location.origin); if (['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) return `${url.pathname}${url.search}`; return clean; } catch { return ''; } }
  const path = clean.replace(/^file:\/\//i, '').replace(/^\/+/, '');
  return /^(uploads|images|assets)\//i.test(path) ? `/${path}` : `/uploads/${path}`;
}
=======
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
function formatDateTime(value) { try { return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return value || '-'; } }
function requireLogin() { if (!getToken()) { location.href = `login.html?next=${encodeURIComponent(location.pathname + location.hash)}`; return false; } return true; }
function requireRole(...roles) { const user = getStoredUser(); if (!getToken()) { location.href = 'login.html'; return false; } if (!roles.includes(user?.role)) { location.href = user?.role === 'admin' ? 'admin.html' : 'profile.html?notice=permission'; return false; } return true; }
function currentPage() { return (location.pathname.split('/').pop() || 'index.html').split('#')[0] || 'index.html'; }
function currentHash() { return location.hash || ''; }
function isPublicSite() { return new URLSearchParams(location.search).get('viewSite') === '1'; }
function roleHome(role) { return role === 'admin' ? 'admin.html' : role === 'owner' ? 'list-vehicle.html' : 'index.html'; }

const NAV_CONFIG = {
  guest: [
    { href: 'index.html', label: 'Home' }, { href: 'find-ride.html', label: 'Find a Ride' }, { href: 'rental.html', label: 'Rent a Vehicle' }
  ],
  user: [
    { href: 'index.html', label: 'Home' }, { href: 'rental.html', label: 'Find Vehicles' }, { href: 'find-ride.html', label: 'Find a Ride' }, { href: 'bookings.html', label: 'My Bookings' }, { href: 'profile.html', label: 'Profile' }
  ],
  owner: [
    { href: 'list-vehicle.html', label: 'Dashboard' }, { href: 'list-vehicle.html#fleet', label: 'My Vehicles' }, { href: 'list-vehicle.html#add', label: 'Add Vehicle' }, { href: 'list-vehicle.html#requests', label: 'Booking Requests' }, { href: 'offer-ride.html', label: 'Offer a Ride' }, { href: 'profile.html', label: 'Profile' }
  ],
  adminLite: [{ href: 'admin.html', label: 'Admin Dashboard' }, { href: 'profile.html', label: 'Profile' }]
};

function showModal(title, message) {
  const modal = document.getElementById('successModal');
  if (!modal) return;
  const heading = modal.querySelector('h2'); const text = modal.querySelector('p');
  if (heading) heading.textContent = title || 'Success';
  if (text) text.textContent = message || '';
  modal.classList.add('show');
}
function closeModal() { document.getElementById('successModal')?.classList.remove('show'); }
document.addEventListener('click', event => { if (event.target?.classList?.contains('modal')) closeModal(); });
<<<<<<< HEAD
document.addEventListener('click', event => { if (event.target?.closest?.('[data-close-modal]')) closeModal(); });
=======
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); document.querySelector('.nav-links.open')?.classList.remove('open'); } });

function buildNav(role, user) {
  const links = document.querySelector('.nav-links');
  const brand = document.querySelector('.brand');
  if (brand) brand.href = roleHome(role);
  if (links) {
    links.replaceChildren();
    const items = NAV_CONFIG[role] || NAV_CONFIG.guest;
    const full = `${currentPage()}${currentHash()}`;
    const activeHref = items.some(item => item.href === full) ? full : currentPage();
    items.forEach(item => {
      const link = document.createElement('a'); link.href = item.href; link.textContent = item.label;
      if (item.href === activeHref || (item.href.includes('#') && location.hash === item.href.split('#')[1])) link.classList.add('active');
      link.addEventListener('click', () => links.classList.remove('open'));
      links.appendChild(link);
    });
  }
  const actions = document.querySelector('.nav-actions');
  if (!actions) return;
  actions.replaceChildren();
<<<<<<< HEAD
  // Dark/light switch is available on every signed-in and guest page.
  if (window.RevaxTheme && !document.querySelector('nav .theme-toggle')) {
    const themeBtn = document.createElement('button');
    themeBtn.type = 'button';
    themeBtn.className = 'theme-toggle';
    themeBtn.setAttribute('aria-pressed', 'false');
    themeBtn.setAttribute('aria-label', 'Switch between dark and light mode');
    themeBtn.innerHTML = '<span class="track"><span class="thumb"></span></span><span class="icon"></span><span class="label"></span>';
    actions.prepend(themeBtn);
    // theme.js owns the click (delegated) and repaints on every theme change.
    window.RevaxTheme.mount(actions);
  }
  if (user) {
    const profile = document.createElement('a'); profile.href = role === 'admin' ? 'admin.html' : 'profile.html'; profile.className = 'user-nav';
    const avatar = document.createElement('span'); avatar.className = 'user-avatar'; avatar.textContent = (user.name || 'R').slice(0, 1).toUpperCase();
    const name = document.createElement('span'); name.className = 'user-nav-name'; name.textContent = user.name || 'Account';
    profile.append(avatar, name); actions.appendChild(profile);
    if (role === 'user') { const owner = document.createElement('a'); owner.href = 'profile.html#owner'; owner.className = 'btn btn-outline'; owner.textContent = 'Become an Owner'; actions.appendChild(owner); }
    if (role === 'owner') { const userLink = document.createElement('a'); userLink.href = 'profile.html#switch'; userLink.className = 'btn btn-outline'; userLink.textContent = 'Switch to User'; actions.appendChild(userLink); }
    const logout = document.createElement('button'); logout.type = 'button'; logout.className = 'btn btn-primary'; logout.textContent = 'Logout'; logout.onclick = () => { clearSession(); location.href = 'index.html'; }; actions.appendChild(logout);
  } else if (isPublicSite() && getToken()) {
    const back = document.createElement('a'); back.href = 'admin.html'; back.className = 'btn btn-outline'; back.textContent = 'Return to Admin'; actions.appendChild(back);
  } else {
    const login = document.createElement('a'); login.href = `login.html?next=${encodeURIComponent(location.pathname + location.hash)}`; login.textContent = 'Log in'; actions.appendChild(login);
    const join = document.createElement('a'); join.href = 'register.html'; join.className = 'btn btn-primary'; join.textContent = `Join ${BRAND}`; actions.appendChild(join);
  }
=======
  if (user) {
    const profile = document.createElement('a'); profile.href = role === 'admin' ? 'admin.html' : 'profile.html'; profile.className = 'user-nav';
    const avatar = document.createElement('span'); avatar.className = 'user-avatar'; avatar.textContent = (user.name || 'R').slice(0, 1).toUpperCase();
    const name = document.createElement('span'); name.className = 'user-nav-name'; name.textContent = user.name || 'Account';
    profile.append(avatar, name); actions.appendChild(profile);
    if (role === 'user') { const owner = document.createElement('a'); owner.href = 'profile.html#owner'; owner.className = 'btn btn-outline'; owner.textContent = 'Become an Owner'; actions.appendChild(owner); }
    if (role === 'owner') { const userLink = document.createElement('a'); userLink.href = 'profile.html#switch'; userLink.className = 'btn btn-outline'; userLink.textContent = 'Switch to User'; actions.appendChild(userLink); }
    const logout = document.createElement('button'); logout.type = 'button'; logout.className = 'btn btn-primary'; logout.textContent = 'Logout'; logout.onclick = () => { clearSession(); location.href = 'index.html'; }; actions.appendChild(logout);
  } else if (isPublicSite() && getToken()) {
    const back = document.createElement('a'); back.href = 'admin.html'; back.className = 'btn btn-outline'; back.textContent = 'Return to Admin'; actions.appendChild(back);
  } else {
    const login = document.createElement('a'); login.href = `login.html?next=${encodeURIComponent(location.pathname + location.hash)}`; login.textContent = 'Log in'; actions.appendChild(login);
    const join = document.createElement('a'); join.href = 'register.html'; join.className = 'btn btn-primary'; join.textContent = `Join ${BRAND}`; actions.appendChild(join);
  }
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
}

function bindMenu() {
  const menu = document.querySelector('.menu-btn'); const links = document.querySelector('.nav-links') || document.querySelector('.admin-tabs');
  if (!menu || !links || menu.dataset.bound) return;
  menu.dataset.bound = '1'; menu.textContent = 'Menu'; menu.setAttribute('aria-expanded', 'false');
  menu.onclick = () => { const open = links.classList.toggle('open'); menu.setAttribute('aria-expanded', String(open)); };
  document.addEventListener('click', event => { if (links.classList.contains('open') && !event.target.closest('.nav, .admin-topbar')) { links.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); } });
  window.addEventListener('resize', () => { if (window.innerWidth > 900 && links.classList.contains('open')) { links.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); } });
}
function applyBrand() {
  document.querySelectorAll('.brand').forEach(brand => { if (!brand.textContent.trim()) brand.innerHTML = 'REV<span>EX</span>'; });
  document.title = document.title.replaceAll('VRUMY', 'REVEX').replaceAll('VROOMY', 'REVEX');
}
async function loadNotifications() {
  if (!getToken() || !document.querySelector('.nav-actions')) return;
  try {
    const items = await api('/notifications'); const unread = items.filter(item => !item.read).length;
    if (!unread) return;
    const button = document.createElement('a'); button.href = 'profile.html#notifications'; button.className = 'notification-link'; button.textContent = `Notifications (${unread})`; document.querySelector('.nav-actions')?.prepend(button);
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  const user = getStoredUser(); const role = user?.role || 'guest'; const page = currentPage(); const publicSite = isPublicSite();
  if (page === 'admin.html') {
    if (role !== 'admin') { location.replace('login.html?next=admin.html'); return; }
    bindMenu(); applyBrand(); return;
  }
  if (publicSite) { document.querySelectorAll('[data-owner-only]').forEach(element => { element.hidden = true; }); buildNav('guest', null); bindMenu(); applyBrand(); return; }
  if (role === 'admin') {
<<<<<<< HEAD
    // Admins may open the agreement viewer and the owner portal (the owner APIs
    // explicitly accept the admin role), but must never be bounced out of
    // admin.html itself.
    if (page === 'profile.html' || page === 'agreement.html') { buildNav('adminLite', user); bindMenu(); applyBrand(); return; }
    if (page === 'list-vehicle.html' || page === 'offer-ride.html') { buildNav('adminLite', user); bindMenu(); applyBrand(); loadNotifications(); return; }
=======
    if (page === 'profile.html') { buildNav('adminLite', user); bindMenu(); applyBrand(); return; }
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
    location.replace('admin.html'); return;
  }
  if (['list-vehicle.html', 'offer-ride.html'].includes(page) && role !== 'owner') { location.replace(role === 'guest' ? `login.html?next=${encodeURIComponent(location.pathname + location.hash)}` : 'profile.html?notice=owner-only'); return; }
  document.querySelectorAll('[data-owner-only]').forEach(element => { element.hidden = !['owner', 'admin'].includes(role); });
  buildNav(role, user); bindMenu(); applyBrand(); loadNotifications();
});

async function downloadAgreement(bookingId) {
  try {
    const response = await fetch(`${API_BASE}/bookings/${encodeURIComponent(bookingId)}/agreement`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!response.ok) { let data = {}; try { data = await response.json(); } catch {} throw new Error(friendlyError(data.message, response.status)); }
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `REVEX-Agreement-${bookingId}.pdf`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  } catch (error) { alert(error.message); }
}

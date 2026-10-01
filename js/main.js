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

  // No explicit port (a proxied deployment such as Render or Vercel) => same-origin.
  if (!location.port) return '/api';

  // The backend serves BOTH the pages and the api on these ports, so the api is
  // same-origin. This is the normal case and is never second-guessed.
  if (REVEX_API_PORTS.includes(location.port)) return '/api';

  // A real deployment is proxied on a port we do not control. Never point it at
  // :5001 there, or every API call would fail in production.
  if (!LOCAL_HOSTS.includes(location.hostname)) return '/api';

  /*
   * Only a known STATIC dev server - a separate frontend with no backend of its
   * own - needs an absolute URL to reach the api on another port.
   *
   * This used to be "any port that is not 5000/5001", which silently broke a
   * backend started with PORT=5002: it was serving the pages itself, but every
   * request was sent to :5001, where nothing was listening, so login failed with
   * a CORS error and a form that did nothing. Same-origin is correct for ANY port
   * the backend chose; only these specific frontend-tool ports need the redirect.
   *
   * Anything else - a backend on 8080, 3001, 5002 - stays same-origin. If you run a
   * separate static server on some other port, set the base explicitly with
   * <meta name="revex-api-base" content="http://localhost:5001/api"> or
   * window.REVEX_API_BASE, which is checked first and always wins.
   */
  const STATIC_DEV_PORTS = ['3000', '4200', '5173', '5500', '8000'];
  if (STATIC_DEV_PORTS.includes(location.port)) {
    return `${location.protocol}//${location.hostname}:${REVEX_DEFAULT_API_PORT}/api`;
  }
  return '/api';
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
  }
  const token = getToken(); if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try { response = await fetch(`${API_BASE}${path}`, { ...options, body, headers }); }
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
  if (!response.ok) throw new Error(friendlyError(data.message, response.status));
  return data;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function formatMoney(value) { return `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`; }
function formatDate(value) { try { return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return value || '-'; } }
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
    { href: 'index.html', label: 'Home' }, { href: 'find-ride.html', label: 'Find a Ride' }, { href: 'rental.html', label: 'Rent a Vehicle' }, { href: 'bookings.html', label: 'My Bookings' }, { href: 'profile.html', label: 'Profile' }
  ],
  owner: [
    { href: 'list-vehicle.html', label: 'Dashboard' }, { href: 'list-vehicle.html#fleet', label: 'My Vehicles' }, { href: 'list-vehicle.html#add', label: 'Add Vehicle' }, { href: 'list-vehicle.html#requests', label: 'Rental Requests' }, { href: 'offer-ride.html', label: 'Offer a Ride' }, { href: 'ride-requests.html', label: 'Ride Requests' }, { href: 'profile.html', label: 'Profile' }
  ],
  adminLite: [{ href: 'admin.html', label: 'Admin Dashboard' }, { href: 'chat.html', label: 'Ask REVEX' }, { href: 'profile.html', label: 'Profile' }],
  adminAgreementLite: [{ href: 'admin.html', label: 'Admin Dashboard' }, { href: 'profile.html', label: 'Profile' }],
  adminProfileLite: [{ href: 'admin.html', label: 'Admin Dashboard' }, { href: 'profile.html', label: 'Profile' }]
};

/* -------------------------------------------------------------------------
 * SHARED UI HELPERS
 *
 * These live in main.js because every page loads it, and having one copy is
 * what stops the same control (a status badge, a toast, an image) from looking
 * different depending on which page you are on.
 * ---------------------------------------------------------------------- */

/**
 * One status vocabulary for the whole UI. The backend sends one of these values
 * for every booking, ride, vehicle and payment; anything unrecognised is shown
 * verbatim rather than silently mapped to "Unknown".
 */
const STATUS_TONE = {
  // vehicles + rides
  approved: 'ok', available: 'ok', completed: 'ok', confirmed: 'ok', paid: 'ok', verified: 'ok', active: 'ok',
  // waiting on somebody
  pending: 'warn', pending_owner: 'warn', payment_pending: 'warn', pending_approval: 'warn',
  // negative but still a valid state
  rejected: 'bad', removed: 'bad', cancelled: 'bad',
  cancelled_by_user: 'bad', cancelled_by_owner: 'bad', cancelled_by_admin: 'bad',
  failed: 'bad', deleted: 'bad', deactivated: 'bad', sold_out: 'bad',
  // refunds
  refunded: 'info', partially_refunded: 'info'
};

const STATUS_LABELS = {
  available: 'Available', approved: 'Approved', pending: 'Pending', rejected: 'Rejected', removed: 'Removed',
  cancelled: 'Cancelled', cancelled_by_user: 'Cancelled by user', cancelled_by_owner: 'Cancelled by owner',
  cancelled_by_admin: 'Cancelled by admin', active: 'In progress', completed: 'Completed',
  confirmed: 'Confirmed', pending_owner: 'Awaiting owner approval', payment_pending: 'Awaiting payment',
  paid: 'Paid', failed: 'Failed', refunded: 'Refunded', partially_refunded: 'Partially refunded',
  verified: 'Verified', deactivated: 'Deactivated'
};

function statusLabel(value) {
  if (!value) return 'Unknown';
  return STATUS_LABELS[String(value)] || String(value).replace(/_/g, ' ').replace(/^./, char => char.toUpperCase());
}

/** `<span class="rvx-badge rvx-badge--ok">Approved</span>` */
function statusBadge(value, extra = '') {
  const key = String(value || '').toLowerCase();
  const tone = STATUS_TONE[key] || 'info';
  const text = escapeHtml(statusLabel(value) + (extra ? ` · ${extra}` : ''));
  return `<span class="rvx-badge rvx-badge--${tone}">${text}</span>`;
}

/**
 * An `<img>` that falls back to initials instead of a broken-image icon.
 * Vehicle photos, profile photos and documents all go through here, so a
 * missing image never shows the browser's torn-picture glyph.
 */
function imageOrInitials(source, name, { className = 'rvx-thumb', alt = '' } = {}) {
  const label = String(name || 'REVEX').trim();
  const initial = escapeHtml((label[0] || 'R').toUpperCase());
  const url = assetUrl(source);
  if (!url) return `<span class="${escapeHtml(className)} rvx-thumb--empty" aria-hidden="true">${initial}</span>`;
  return `<img class="${escapeHtml(className)}" src="${escapeHtml(url)}" alt="${escapeHtml(alt || label)}" loading="lazy" decoding="async" `
    + `onerror="this.outerHTML='<span class=&quot;${escapeHtml(className)} rvx-thumb--empty&quot; aria-hidden=&quot;true&quot;>${initial}</span>'">`;
}

/** Non-blocking feedback. `alert()` is only used for genuinely blocking asks. */
function showToast(message, tone = 'info', timeout = 4500) {
  let host = document.querySelector('.rvx-toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'rvx-toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const toast = document.createElement('div');
  toast.className = `rvx-toast rvx-toast--${tone}`;
  toast.textContent = String(message || '');
  host.appendChild(toast);
  // Trigger the entry animation on the next frame.
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 260);
  }, timeout);
  return toast;
}

/** Promise-based confirm that reads as part of the product, not a browser dialog. */
function confirmAction({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'primary', reasonLabel = '', reasonRequired = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'rvx-confirm';
    overlay.innerHTML = `
      <div class="rvx-confirm__card" role="dialog" aria-modal="true" aria-labelledby="rvxConfirmTitle">
        <h2 id="rvxConfirmTitle">${escapeHtml(title || 'Are you sure?')}</h2>
        <p>${escapeHtml(message || '')}</p>
        ${reasonLabel ? `<label class="rvx-field"><span>${escapeHtml(reasonLabel)}</span><textarea rows="3" data-reason placeholder="Explain what happened"></textarea></label>` : ''}
        <div class="rvx-confirm__actions">
          <button type="button" class="btn btn-outline" data-cancel>${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn btn-${tone === 'danger' ? 'danger' : 'primary'}" data-confirm>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const finish = value => { overlay.remove(); resolve(value); };
    const reason = overlay.querySelector('[data-reason]');
    overlay.querySelector('[data-cancel]').onclick = () => finish(null);
    overlay.querySelector('[data-confirm]').onclick = () => {
      const text = reason ? reason.value.trim() : '';
      if (reasonRequired && !text) { reason?.focus(); showToast('Please enter a reason.', 'bad'); return; }
      finish({ reason: text });
    };
    overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') finish(null); });
    (reason || overlay.querySelector('[data-confirm]')).focus();
  });
}

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
document.addEventListener('click', event => { if (event.target?.closest?.('[data-close-modal]')) closeModal(); });
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
      if (item.href === activeHref || (item.href.includes('#') && currentHash() === `#${item.href.split('#')[1]}`)) {
        link.classList.add('active');
        link.setAttribute('aria-current', 'page');
      }
      link.addEventListener('click', () => links.classList.remove('open'));
      links.appendChild(link);
    });
  }
  const actions = document.querySelector('.nav-actions');
  if (!actions) return;
  actions.replaceChildren();
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
    // The same profile picture the owner uploaded, so the navbar, the profile
    // page and the admin lists never disagree about who this is.
    profile.insertAdjacentHTML('afterbegin', imageOrInitials(user.photo, user.name, { className: 'user-avatar', alt: '' }));
    const name = document.createElement('span'); name.className = 'user-nav-name'; name.textContent = user.name || 'Account';
    profile.appendChild(name); actions.appendChild(profile);
    // Keep role headers focused on the current workspace. Rider/owner switching
    // is handled inside Profile rather than adding a second workspace button
    // to every owner page.
    const logout = document.createElement('button'); logout.type = 'button'; logout.className = 'btn btn-primary'; logout.textContent = 'Logout'; logout.onclick = () => { clearSession(); location.href = 'index.html'; }; actions.appendChild(logout);
  } else if (isPublicSite() && getToken()) {
    const back = document.createElement('a'); back.href = 'admin.html'; back.className = 'btn btn-outline'; back.textContent = 'Return to Admin'; actions.appendChild(back);
  } else {
    const login = document.createElement('a'); login.href = `login.html?next=${encodeURIComponent(location.pathname + location.hash)}`; login.textContent = 'Log in'; actions.appendChild(login);
    const join = document.createElement('a'); join.href = 'register.html'; join.className = 'btn btn-primary'; join.textContent = `Join ${BRAND}`; actions.appendChild(join);
  }
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
    const button = document.createElement('a');
    button.href = 'profile.html#notifications';
    button.className = 'notification-link';
    button.setAttribute('aria-label', `${unread} unread notification${unread === 1 ? '' : 's'}`);
    button.title = `${unread} unread notification${unread === 1 ? '' : 's'}`;
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg><span class="notification-count"></span>';
    button.querySelector('.notification-count').textContent = String(unread);
    document.querySelector('.nav-actions')?.prepend(button);
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  const user = getStoredUser(); const role = user?.role || 'guest'; const page = currentPage(); const publicSite = isPublicSite();
  document.documentElement.setAttribute('data-role', role);
  document.body?.setAttribute('data-role', role);
  if (page === 'admin.html') {
    if (role !== 'admin') { location.replace('login.html?next=admin.html'); return; }
    bindMenu();
    applyBrand();
    // Keep the admin header focused on admin navigation. The assistant uses the
    // same bottom-right floating Ask REVEX launcher as the rider/owner pages.
    if (!document.body.dataset.noChatLauncher) window.RevexChat?.mount({ launcher: true });
    return;
  }
  if (publicSite) { document.querySelectorAll('[data-owner-only]').forEach(element => { element.hidden = true; }); buildNav('guest', null); bindMenu(); applyBrand(); return; }
  if (role === 'admin') {
    // Admins may open the agreement viewer, the owner portal and the assistant
    // (the owner APIs explicitly accept the admin role), but must never be
    // bounced out of admin.html itself.
    if (page === 'agreement.html') {
      // Keep the rental agreement header clean and consistent with the admin
      // dashboard. Ask REVEX is available as the standard floating launcher.
      buildNav('adminAgreementLite', user);
      bindMenu();
      applyBrand();
      if (!document.body.dataset.noChatLauncher) window.RevexChat?.mount({ launcher: true });
      return;
    }
    if (page === 'profile.html') {
      // Profile keeps the same clean admin header pattern as the agreement
      // page, with Ask REVEX exposed as the floating launcher instead of a
      // top-nav item.
      buildNav('adminProfileLite', user);
      bindMenu();
      applyBrand();
      if (!document.body.dataset.noChatLauncher) window.RevexChat?.mount({ launcher: true });
      return;
    }
    if (page === 'chat.html') { buildNav('adminLite', user); bindMenu(); applyBrand(); return; }
    if (['list-vehicle.html', 'offer-ride.html', 'ride-requests.html'].includes(page)) { buildNav('adminLite', user); bindMenu(); applyBrand(); loadNotifications(); return; }
    location.replace('admin.html'); return;
  }
  if (['list-vehicle.html', 'offer-ride.html', 'ride-requests.html'].includes(page) && role !== 'owner') { location.replace(role === 'guest' ? `login.html?next=${encodeURIComponent(location.pathname + location.hash)}` : 'profile.html?notice=owner-only'); return; }
  document.querySelectorAll('[data-owner-only]').forEach(element => { element.hidden = !['owner', 'admin'].includes(role); });
  buildNav(role, user); bindMenu(); applyBrand(); loadNotifications();
  // The assistant launcher is available to every signed-in account (rider,
  // owner and admin) on every page, so the full-screen chat page is optional.
  // chat.js owns the widget; this only asks for the launcher variant.
  if (user && !document.body.dataset.noChatLauncher) window.RevexChat?.mount({ launcher: true });
});

/**
 * The shared namespace.
 *
 * Every page includes main.js, so the new modules (payment, chat, ride requests)
 * and the pages can all reach the same helpers without each one re-declaring
 * them. Exported as one object so nothing leaks into the global scope by
 * accident.
 */
window.REVEX = {
  API_BASE, BRAND, CURRENCY,
  api, escapeHtml, formatMoney, formatDate, formatDateTime, assetUrl,
  getToken, getStoredUser, setSession, clearSession, friendlyError,
  requireLogin, requireRole, currentPage, roleHome,
  showModal, closeModal, showToast, confirmAction,
  statusBadge, statusLabel, imageOrInitials,
  NAV_CONFIG, buildNav
};

/*
 * The older page scripts (js/rental.js, js/owner.js, js/admin.js) were written
 * before the namespace existed and reference these helpers as bare globals, the
 * same way they already use `api()` and `escapeHtml()`. Rather than rewriting
 * every one of them, the shared UI helpers are published globally here too.
 * Anything defined AFTER this block wins, so a page script may still shadow a
 * helper deliberately - and tests/no-duplicate-helpers.test.js fails if a page
 * script does so accidentally, which is how the duplicate statusBadge() in
 * js/booking.js was found.
 */
window.statusBadge = statusBadge;
window.statusLabel = statusLabel;
window.imageOrInitials = imageOrInitials;
window.showToast = showToast;
window.confirmAction = confirmAction;

async function downloadAgreement(bookingId) {
  try {
    const response = await fetch(`${API_BASE}/bookings/${encodeURIComponent(bookingId)}/agreement`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!response.ok) { let data = {}; try { data = await response.json(); } catch {} throw new Error(friendlyError(data.message, response.status)); }
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `REVEX-Agreement-${bookingId}.pdf`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  } catch (error) { showToast(error.message, 'bad'); }
}

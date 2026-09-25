const API_BASE = '/api';
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
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    body = JSON.stringify(body); headers['Content-Type'] = 'application/json';
  }
  const token = getToken(); if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try { response = await fetch(`${API_BASE}${path}`, { ...options, body, headers }); }
  catch { throw new Error('Cannot reach the REVEX service. Check your connection and try again.'); }
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(friendlyError(data.message, response.status));
  return data;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function formatMoney(value) { return `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`; }
function formatDate(value) { try { return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return value || '-'; } }
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
    if (page === 'profile.html') { buildNav('adminLite', user); bindMenu(); applyBrand(); return; }
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

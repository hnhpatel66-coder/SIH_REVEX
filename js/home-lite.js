(function (window) {
  /* REVEX home stability controller.
     Intentionally self-contained: no API fetches, notifications, observers, or
     render loops. The floating Ask REVEX control is a lightweight link here; the
     full authenticated assistant still lives on the app pages. */
  'use strict';

  function read(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function storedUser() {
    try { return JSON.parse(read('revexUser') || read('vroomyUser') || 'null'); } catch (_) { return null; }
  }
  function token() { return read('revexToken') || read('vroomyToken') || ''; }
  function clearSession() {
    try { ['revexToken','revexUser','vroomyToken','vroomyUser'].forEach(k => localStorage.removeItem(k)); } catch (_) {}
  }

  const NAV = {
    guest: [
      ['index.html','Home'], ['find-ride.html','Find a Ride'], ['rental.html','Rent a Vehicle']
    ],
    user: [
      ['index.html','Home'], ['find-ride.html','Find a Ride'], ['rental.html','Rent a Vehicle'], ['bookings.html','My Bookings'], ['profile.html','Profile']
    ],
    owner: [
      ['list-vehicle.html','Dashboard'], ['list-vehicle.html#fleet','My Vehicles'], ['list-vehicle.html#add','Add Vehicle'],
      ['list-vehicle.html#requests','Rental Requests'], ['offer-ride.html','Offer a Ride'], ['ride-requests.html','Ride Requests'], ['profile.html','Profile']
    ],
    admin: [
      ['admin.html?tab=dashboard','Dashboard'], ['admin.html?tab=owners','Owners'], ['admin.html?tab=vehicles','Vehicles'],
      ['admin.html?tab=rideApprovals','Ride Approvals'], ['admin.html?tab=bookings','Rental Bookings'],
      ['admin.html?tab=payments','Payments'],
      ['admin.html?tab=agreements','Agreements'], ['admin.html?tab=reports','Reports'],
      ['admin.html?tab=users','Users'], ['admin.html?tab=settings','Settings']
    ]
  };

  function makeThemeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Switch between dark and light mode');
    btn.innerHTML = '<span class="track"><span class="thumb"></span></span><span class="icon"></span><span class="label"></span>';
    return btn;
  }

  function actionLink(href, text, className) {
    const a = document.createElement('a');
    a.href = href; a.textContent = text; if (className) a.className = className;
    return a;
  }

  function buildHeader() {
    const user = storedUser();
    const signedIn = Boolean(token() && user);
    const rawRole = signedIn ? user.role : 'guest';
    const role = ['user','owner','admin'].includes(rawRole) ? rawRole : 'guest';
    document.documentElement.dataset.role = role;
    document.body.dataset.role = role;

    const links = document.querySelector('.nav-links');
    if (links) {
      links.replaceChildren();
      (NAV[role] || NAV.guest).forEach(([href,label]) => {
        const a = document.createElement('a');
        a.href = href; a.textContent = label;
        if ((href.split('#')[0] || 'index.html') === 'index.html') {
          a.classList.add('active');
          a.setAttribute('aria-current', 'page');
        }
        links.appendChild(a);
      });
    }

    const brand = document.querySelector('.brand');
    if (brand) brand.href = role === 'admin' ? 'admin.html' : role === 'owner' ? 'list-vehicle.html' : 'index.html';

    document.querySelectorAll('[data-owner-only]').forEach(el => { el.hidden = role !== 'owner'; });

    const actions = document.querySelector('.nav-actions');
    if (!actions) return;
    actions.replaceChildren();
    const themeBtn = makeThemeButton();
    actions.appendChild(themeBtn);
    window.RevaxTheme?.mount(actions);

    if (signedIn) {
      const roleLabel = role === 'admin' ? 'Admin' : role === 'owner' ? 'Owner' : 'User';
      const roleHref = role === 'admin' ? 'admin.html' : 'profile.html';
      const rolePill = actionLink(roleHref, roleLabel, 'user-nav home-lite-role');
      rolePill.setAttribute('aria-label', role === 'admin' ? 'Open Admin Control Centre' : `Open ${roleLabel} profile`);
      actions.appendChild(rolePill);
      // Keep each signed-in header focused on the active role. Admins get the
      // same persistent workspace navigation pattern as owners, rather than a
      // temporary public header with a separate "Return to Admin" button.
      const logout = document.createElement('button');
      logout.type = 'button'; logout.className = 'btn btn-primary'; logout.textContent = 'Logout';
      logout.addEventListener('click', () => { clearSession(); location.replace('index.html'); });
      actions.appendChild(logout);
    } else {
      actions.appendChild(actionLink('login.html?next=index.html', 'Log in', 'home-lite-login'));
      actions.appendChild(actionLink('register.html', 'Join REVEX', 'btn btn-primary'));
    }

    const menu = document.querySelector('.menu-btn');
    if (menu && links) {
      menu.setAttribute('aria-expanded', 'false');
      menu.addEventListener('click', () => {
        const open = links.classList.toggle('open');
        menu.setAttribute('aria-expanded', String(open));
      });
      links.addEventListener('click', event => {
        if (event.target.closest('a')) {
          links.classList.remove('open');
          menu.setAttribute('aria-expanded', 'false');
        }
      });
      document.addEventListener('click', event => {
        if (links.classList.contains('open') && !event.target.closest('.nav')) {
          links.classList.remove('open');
          menu.setAttribute('aria-expanded', 'false');
        }
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && links.classList.contains('open')) {
          links.classList.remove('open');
          menu.setAttribute('aria-expanded', 'false');
          menu.focus();
        }
      });
      window.addEventListener('resize', () => {
        if (window.innerWidth > 900 && links.classList.contains('open')) {
          links.classList.remove('open');
          menu.setAttribute('aria-expanded', 'false');
        }
      });
    }

    if (!document.querySelector('.home-lite-ask')) {
      const askTarget = signedIn ? 'chat.html' : 'login.html?next=chat.html';
      const ask = actionLink(askTarget, 'Ask REVEX', 'rvx-chat-launcher home-lite-ask');
      ask.setAttribute('aria-label', signedIn ? 'Ask REVEX' : 'Log in to Ask REVEX');
      ask.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3 1.7-5.1A7 7 0 0 1 3 12V8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7Z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/></svg><b>Ask REVEX</b>';
      document.body.appendChild(ask);
    }
  }

  function cleanupLocalhostServiceWorkers() {
    if (!['localhost','127.0.0.1'].includes(location.hostname)) return;
    // Do this asynchronously after the page is interactive. It never blocks render.
    setTimeout(() => {
      try {
        if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
        if ('caches' in window) caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
      } catch (_) {}
    }, 1200);
  }

  function init() {
    buildHeader();
    cleanupLocalhostServiceWorkers();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})(window);

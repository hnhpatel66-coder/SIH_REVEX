(function (window, document) {
  'use strict';

  function initAdminMobileMenu() {
    const topbar = document.querySelector('.admin-topbar');
    const inner = document.querySelector('.admin-topbar-inner');
    const menu = document.querySelector('.admin-menu');
    const tabs = document.querySelector('.admin-tabs');
    const mobileActions = document.querySelector('.admin-mobile-actions');
    if (!topbar || !inner || !menu || !tabs) return;

    document.querySelectorAll('[data-tab="rideBookings"], #panel-rideBookings, [data-go-tab="rideBookings"]').forEach(n => n.remove());
    tabs.querySelectorAll('button, a').forEach(n => {
      if (n.textContent.trim().toLowerCase() === 'ride bookings') n.remove();
    });

    if (!tabs.querySelector('.admin-nav-logout')) {
      const logout = document.createElement('button');
      logout.type = 'button';
      logout.className = 'admin-nav-logout';
      logout.textContent = 'Logout';
      logout.addEventListener('click', function () {
        try { if (window.REVEX && typeof window.REVEX.clearSession === 'function') window.REVEX.clearSession(); } catch (_) {}
        location.href = 'index.html';
      });
      tabs.appendChild(logout);
    }

    tabs.id = tabs.id || 'adminNavigation';
    menu.setAttribute('aria-controls', tabs.id);
    menu.setAttribute('aria-haspopup', 'true');
    menu.setAttribute('aria-expanded', 'false');
    // Remove the generic main.js onclick binder so one tap cannot toggle twice.
    menu.onclick = null;
    menu.dataset.bound = 'admin-detached-mobile-v8';

    function isMobile() { return window.matchMedia('(max-width: 1000px)').matches; }

    function placeMenu() {
      if (isMobile()) {
        if (tabs.parentElement !== topbar.parentElement || tabs.previousElementSibling !== topbar) {
          topbar.insertAdjacentElement('afterend', tabs);
        }
        tabs.classList.add('admin-mobile-detached');
      } else {
        tabs.classList.remove('admin-mobile-detached', 'open');
        if (mobileActions && mobileActions.parentElement === inner) inner.insertBefore(tabs, mobileActions);
        else inner.appendChild(tabs);
        document.body.classList.remove('admin-nav-open');
        menu.textContent = 'Menu';
        menu.setAttribute('aria-expanded', 'false');
      }
    }

    function setOpen(open) {
      if (!isMobile()) return;
      placeMenu();
      tabs.classList.toggle('open', !!open);
      document.body.classList.toggle('admin-nav-open', !!open);
      menu.textContent = open ? 'Close' : 'Menu';
      menu.setAttribute('aria-expanded', String(!!open));
      menu.setAttribute('aria-label', open ? 'Close admin navigation' : 'Open admin navigation');
    }

    menu.addEventListener('click', function (event) {
      if (!isMobile()) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(!tabs.classList.contains('open'));
    });

    tabs.addEventListener('click', function (event) {
      const item = event.target.closest('.admin-tab');
      if (!item) return;
      if (window.RevexAdmin && typeof window.RevexAdmin.showTab === 'function') {
        event.preventDefault();
        window.RevexAdmin.showTab(item.dataset.tab, { history: 'push' });
      }
      setOpen(false);
      requestAnimationFrame(() => document.querySelector('.admin-main')?.scrollIntoView({ block: 'start' }));
    });

    document.addEventListener('click', function (event) {
      if (!tabs.classList.contains('open')) return;
      if (event.target.closest('.admin-tabs, .admin-menu')) return;
      setOpen(false);
    });

    document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
    window.addEventListener('resize', function () { placeMenu(); if (!isMobile()) setOpen(false); }, { passive: true });

    placeMenu();
    setOpen(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAdminMobileMenu, { once: true });
  else initAdminMobileMenu();
})(window, document);

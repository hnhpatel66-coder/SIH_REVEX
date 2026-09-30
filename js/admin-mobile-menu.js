(function (window, document) {
  'use strict';

  function initAdminMobileMenu() {
    const topbar = document.querySelector('.admin-topbar');
    const inner = document.querySelector('.admin-topbar-inner');
    const menu = document.querySelector('.admin-menu');
    const tabs = document.querySelector('.admin-tabs');
    const mobileActions = document.querySelector('.admin-mobile-actions');
    const scrollLeftButton = document.getElementById('adminTabScrollLeft');
    const scrollRightButton = document.getElementById('adminTabScrollRight');
    if (!topbar || !inner || !menu || !tabs) return;

    document.querySelectorAll('[data-tab="rideBookings"], #panel-rideBookings, [data-go-tab="rideBookings"]').forEach(n => n.remove());
    tabs.querySelectorAll('button, a').forEach(n => {
      if (n.textContent.trim().toLowerCase() === 'ride bookings') n.remove();
    });

    function ensureMobileLogout() {
      let logout = tabs.querySelector('.admin-nav-logout');
      if (!logout) {
        logout = document.createElement('button');
        logout.type = 'button';
        logout.className = 'admin-nav-logout';
        logout.textContent = 'Logout';
        logout.addEventListener('click', function () {
          try { if (window.REVEX && typeof window.REVEX.clearSession === 'function') window.REVEX.clearSession(); } catch (_) {}
          location.href = 'index.html';
        });
        tabs.appendChild(logout);
      }
      return logout;
    }

    tabs.id = tabs.id || 'adminNavigation';
    menu.setAttribute('aria-controls', tabs.id);
    menu.setAttribute('aria-haspopup', 'true');
    menu.setAttribute('aria-expanded', 'false');
    // Remove the generic main.js onclick binder so one tap cannot toggle twice.
    menu.onclick = null;
    menu.dataset.bound = 'admin-detached-mobile-v8';

    function isMobile() { return window.matchMedia('(max-width: 1000px)').matches; }

    // When Admin is opened from the public Home page, some browsers restore the
    // horizontal scroll position of the tab strip before this script places it
    // back into the desktop header. That can clip the first label to "board".
    // Only normalize the initial Dashboard entry; normal tab navigation remains
    // untouched.
    function normalizeInitialDesktopTabPosition() {
      if (isMobile()) return;
      const active = tabs.querySelector('.admin-tab.active');
      const queryTab = new URLSearchParams(location.search).get('tab');
      const isDashboardEntry = (!queryTab || queryTab === 'dashboard') && (!active || active.dataset.tab === 'dashboard');
      if (!isDashboardEntry) return;
      tabs.scrollLeft = 0;
    }

    function placeMenu() {
      if (isMobile()) {
        ensureMobileLogout();
        if (tabs.parentElement !== topbar.parentElement || tabs.previousElementSibling !== topbar) {
          topbar.insertAdjacentElement('afterend', tabs);
        }
        tabs.classList.add('admin-mobile-detached');
      } else {
        tabs.querySelector('.admin-nav-logout')?.remove();
        tabs.classList.remove('admin-mobile-detached', 'open');
        const actions = inner.querySelector('.admin-actions');
        if (scrollRightButton && scrollRightButton.parentElement === inner) inner.insertBefore(tabs, scrollRightButton);
        else if (actions) inner.insertBefore(tabs, actions);
        else if (mobileActions && mobileActions.parentElement === inner) inner.insertBefore(tabs, mobileActions);
        else inner.appendChild(tabs);
        document.body.classList.remove('admin-nav-open');
        menu.textContent = 'Menu';
        menu.setAttribute('aria-expanded', 'false');
      }
    }

    function updateDesktopSlider() {
      if (isMobile()) return;
      const max = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
      const hasOverflow = max > 2;
      const atStart = tabs.scrollLeft <= 2;
      const atEnd = tabs.scrollLeft >= max - 2;
      if (scrollLeftButton) {
        scrollLeftButton.classList.toggle('is-visible', hasOverflow && !atStart);
        scrollLeftButton.disabled = !hasOverflow || atStart;
      }
      if (scrollRightButton) {
        scrollRightButton.classList.toggle('is-visible', hasOverflow && !atEnd);
        scrollRightButton.disabled = !hasOverflow || atEnd;
      }
    }

    function revealTab(tab, behavior) {
      if (isMobile() || !tab) return;
      const left = tab.offsetLeft;
      const right = left + tab.offsetWidth;
      const viewLeft = tabs.scrollLeft;
      const viewRight = viewLeft + tabs.clientWidth;
      if (left < viewLeft + 4) {
        tabs.scrollTo({ left: Math.max(0, left - 8), behavior: behavior || 'smooth' });
      } else if (right > viewRight - 4) {
        tabs.scrollTo({ left: Math.max(0, right - tabs.clientWidth + 8), behavior: behavior || 'smooth' });
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

    scrollLeftButton?.addEventListener('click', function () {
      tabs.scrollBy({ left: -Math.max(220, Math.round(tabs.clientWidth * 0.62)), behavior: 'smooth' });
    });
    scrollRightButton?.addEventListener('click', function () {
      tabs.scrollBy({ left: Math.max(220, Math.round(tabs.clientWidth * 0.62)), behavior: 'smooth' });
    });
    tabs.addEventListener('scroll', updateDesktopSlider, { passive: true });

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
      if (!isMobile()) requestAnimationFrame(() => { revealTab(item, 'smooth'); updateDesktopSlider(); });
      requestAnimationFrame(() => document.querySelector('.admin-main')?.scrollIntoView({ block: 'start' }));
    });

    document.addEventListener('click', function (event) {
      if (!tabs.classList.contains('open')) return;
      if (event.target.closest('.admin-tabs, .admin-menu')) return;
      setOpen(false);
    });

    document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
    window.addEventListener('resize', function () { placeMenu(); if (!isMobile()) { setOpen(false); requestAnimationFrame(updateDesktopSlider); } }, { passive: true });

    placeMenu();
    setOpen(false);

    // Run after layout (twice) because the header width changes when account
    // actions, fonts and restored browser state settle. Also cover bfcache
    // restores when returning from the Home page.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      normalizeInitialDesktopTabPosition();
      updateDesktopSlider();
      revealTab(tabs.querySelector('.admin-tab.active'), 'auto');
    }));
    window.addEventListener('pageshow', () => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        normalizeInitialDesktopTabPosition();
        updateDesktopSlider();
        revealTab(tabs.querySelector('.admin-tab.active'), 'auto');
      }));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAdminMobileMenu, { once: true });
  else initAdminMobileMenu();
})(window, document);

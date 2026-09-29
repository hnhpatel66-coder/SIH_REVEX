/* REVEX final frontend compatibility fixes — stability-first. No observers, no render loops. */
(function () {
  'use strict';

  function storedUser() {
    try {
      if (window.REVEX && typeof window.REVEX.getStoredUser === 'function') return window.REVEX.getStoredUser();
      return JSON.parse(localStorage.getItem('revexUser') || localStorage.getItem('vroomyUser') || 'null');
    } catch (_) { return null; }
  }

  function syncRole() {
    const user = storedUser();
    const role = user && user.role ? user.role : 'guest';
    document.documentElement.dataset.role = role;
    document.body.dataset.role = role;
    document.querySelectorAll('.rvx-workspace-label').forEach(node => node.remove());
  }

  function markHome() {
    const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    if (page === '' || page === 'index.html') document.body.classList.add('home-page');
  }

  function repairBrand() {
    document.querySelectorAll('.visual-title .mini-logo').forEach(node => {
      const img = document.createElement('img');
      img.className = 'mini-brand-mark';
      img.src = 'assets/revex-mark.png';
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      node.replaceWith(img);
    });
  }

  function repairChatPage() {
    const panel = document.querySelector('.rvx-chat-panel[data-host="page"]');
    if (!panel) return;
    panel.setAttribute('aria-hidden', 'false');
    panel.classList.add('is-open');
    panel.querySelectorAll('[data-close],[data-new]').forEach(button => button.setAttribute('hidden', ''));
  }

  function init() {
    markHome();
    syncRole();
    repairBrand();
    repairChatPage();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  window.addEventListener('pageshow', init, { passive: true });
})();

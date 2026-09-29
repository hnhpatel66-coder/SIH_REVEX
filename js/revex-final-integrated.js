/* REVEX final visual integration — browser-stability edition. */
(function(){
  'use strict';

  function storedUser(){
    try {
      if (window.REVEX && typeof window.REVEX.getStoredUser === 'function') return window.REVEX.getStoredUser();
      return JSON.parse(localStorage.getItem('revexUser') || localStorage.getItem('vroomyUser') || 'null');
    } catch (_) { return null; }
  }

  function syncRoleAndHeader(){
    const user = storedUser();
    const role = user && user.role ? user.role : 'guest';
    document.documentElement.dataset.role = role;
    document.body.dataset.role = role;
    document.querySelectorAll('.rvx-workspace-label').forEach(el => el.remove());
    document.querySelectorAll('.rvx-subnav').forEach(el => el.setAttribute('hidden',''));
  }

  function syncLogoAlt(){
    document.querySelectorAll('a.brand img.brand-mark').forEach(img => {
      img.alt = '';
      img.setAttribute('aria-hidden','true');
    });
  }

  function init(){
    syncRoleAndHeader();
    syncLogoAlt();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
  window.addEventListener('pageshow', init, {passive:true});
})();

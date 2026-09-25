/* ============================================================================
   REVEX theme controller (dark / light)
   Loaded on every page BEFORE the stylesheets render is not possible for a
   plain <script src>, so pages include a tiny inline snippet in <head> to set
   data-theme before first paint. This file provides the interactive parts.
   ========================================================================== */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'revexTheme';
  var listeners = [];

  // REVEX is a light-first design: the light theme is the default and the OS
  // "prefers-color-scheme" is deliberately NOT consulted, so a visitor whose
  // operating system is set to dark still lands on the light design. Dark mode
  // is opt-in via the navbar toggle or the Appearance picker in Profile.
  var DEFAULT_THEME = 'light';

  function stored() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }

  function current() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function apply(theme, persist) {
    var next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    if (persist) { try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* private mode */ } }
    listeners.forEach(function (fn) { try { fn(next); } catch (e) { /* ignore */ } });
    return next;
  }

  function toggle() { return apply(current() === 'dark' ? 'light' : 'dark', true); }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  function iconFor(theme) { return theme === 'dark' ? '\u2600' : '\u263D'; }
  function labelFor(theme) { return theme === 'dark' ? 'Light mode' : 'Dark mode'; }

  /**
   * Wires every .theme-toggle button on the page.
   * Markup contract: <button class="theme-toggle" aria-pressed="false">
   *   <span class="track"><span class="thumb"></span></span>
   *   <span class="icon"></span><span class="label"></span>
   * </button>
   */
  function mount(root) {
    var nodes = (root || document).querySelectorAll('.theme-toggle');
    Array.prototype.forEach.call(nodes, function (btn) {
      var track = btn.querySelector('.track');
      var thumb = btn.querySelector('.thumb');
      if (track && !thumb) { thumb = document.createElement('span'); thumb.className = 'thumb'; track.appendChild(thumb); }
      var iconEl = btn.querySelector('.icon');
      var labelEl = btn.querySelector('.label');
      var titleEl = btn.querySelector('.theme-name');

      function paint(theme) {
        btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        if (iconEl) iconEl.textContent = iconFor(theme);
        if (labelEl) labelEl.textContent = labelFor(theme);
        if (titleEl) titleEl.textContent = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        btn.setAttribute('title', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      }
      paint(current());
      if (btn.dataset.themeBound === '1') return;
      btn.dataset.themeBound = '1';

      // The button has no handler of its own: a toggle injected elsewhere
      // (see main.js buildNav) owns the click. Instead, repaint whenever the
      // theme changes from ANY source -- this toggle or the profile picker --
      // so the label/icon never go stale.
      onChange(paint);
    });
  }

  function setInitialTheme() {
    // Only an explicit stored choice wins; otherwise light.
    var saved = stored();
    apply(saved === 'dark' ? 'dark' : DEFAULT_THEME, false);
  }

  // One delegated handler covers every .theme-toggle on the page, whether it
  // was authored in the markup (auth pages) or injected by buildNav().
  document.addEventListener('click', function (event) {
    var btn = event.target.closest && event.target.closest('.theme-toggle');
    if (btn) { event.preventDefault(); toggle(); }
  });

  global.RevaxTheme = global.RevaxTheme || {
    get: current,
    set: function (t) { return apply(t, true); },
    toggle: toggle,
    onChange: onChange,
    mount: mount,
    init: function () { setInitialTheme(); if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(); }); else mount(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(); });
  else mount();
})(window);

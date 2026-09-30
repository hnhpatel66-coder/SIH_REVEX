/* REVEX unified UI helpers.
 * Keeps the production app vanilla while exposing the same loading-button
 * behaviour used by the supplied React component.
 */
(function (global) {
  'use strict';

  function text(node) {
    return String(node?.textContent || '').trim();
  }

  function start(button, label) {
    if (!button) return;
    button.dataset.revexIdleLabel = button.dataset.revexIdleLabel || text(button);
    button.classList.add('rvex-async-button', 'is-loading');
    button.classList.remove('is-success', 'is-error');
    button.disabled = true;
    if (label) button.textContent = label;
    button.setAttribute('aria-busy', 'true');
  }

  function success(button, label, resetAfter = 1400) {
    if (!button) return;
    button.classList.add('rvex-async-button', 'is-success');
    button.classList.remove('is-loading', 'is-error');
    button.disabled = true;
    if (label) button.textContent = label;
    button.removeAttribute('aria-busy');
    setTimeout(() => reset(button), resetAfter);
  }

  function error(button, label) {
    if (!button) return;
    button.classList.add('rvex-async-button', 'is-error');
    button.classList.remove('is-loading', 'is-success');
    button.disabled = false;
    if (label) button.textContent = label;
    button.removeAttribute('aria-busy');
  }

  function reset(button, label) {
    if (!button) return;
    button.classList.remove('rvex-async-button', 'is-loading', 'is-success', 'is-error');
    button.removeAttribute('aria-busy');
    const idle = label || button.dataset.revexIdleLabel;
    if (idle) button.textContent = idle;
    button.disabled = false;
  }

  function decorate(button) {
    if (!button || button.dataset.revexDecorated) return;
    button.dataset.revexDecorated = '1';
    button.classList.add('rvex-async-button');
  }

  function infer(button) {
    if (!button || button.type === 'button' && !button.closest('form')) return;
    decorate(button);
    const label = text(button).toLowerCase();
    const busy = button.disabled && /(loading|saving|working|processing|searching|submitting|booking|signing|publishing|creating|updating|sending|paying|verifying|please wait|…|\.\.\.)/i.test(label);
    if (busy) {
      button.classList.add('is-loading');
      button.classList.remove('is-success', 'is-error');
      button.setAttribute('aria-busy', 'true');
    } else if (!button.disabled) {
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
    }
  }

  function boot() {
    document.querySelectorAll('button[type="submit"], .rvx-btn, .btn').forEach(infer);
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        const target = mutation.target?.closest ? mutation.target.closest('button, .rvx-btn, .btn') : null;
        if (target) infer(target);
        mutation.addedNodes?.forEach(node => {
          if (node.nodeType !== 1) return;
          if (node.matches?.('button, .rvx-btn, .btn')) infer(node);
          node.querySelectorAll?.('button, .rvx-btn, .btn').forEach(infer);
        });
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
  }

  global.RevexButtonUI = { start, success, error, reset, decorate };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})(window);

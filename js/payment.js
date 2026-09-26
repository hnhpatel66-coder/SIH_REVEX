/* ============================================================================
 * SHARED RAZORPAY CLIENT  (js/payment.js)
 *
 * The rental and the ride booking screens each had their own checkout code, and
 * each decided independently whether to open Razorpay or the test path. They
 * also each opened the Razorpay script tag again, and neither one guarded
 * against a double click, so a fast second click could create two bookings for
 * one payment.
 *
 * This module is used by both and owns:
 *   - loading the Razorpay script exactly once,
 *   - asking the SERVER which payment method is available,
 *   - a single `settle()` latch so one booking can only be settled once,
 *   - releasing the held seats when the rider closes the checkout window.
 *
 * The amount is never taken from this file: it comes from the backend response
 * that created the order.
 * ========================================================================== */
(function (global) {
  'use strict';

  const R = global.REVEX || {};
  const api = R.api;
  const showToast = R.showToast || (message => console.warn(message));
  const escapeHtml = R.escapeHtml || (value => String(value ?? ''));

  let scriptPromise = null;
  let configPromise = null;
  let cachedConfig = null;

  /** In-flight settlements, keyed by booking id. The latch lives here. */
  const settling = new Map();

  const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

  function loadCheckoutScript() {
    if (global.Razorpay) return Promise.resolve(global.Razorpay);
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${CHECKOUT_SCRIPT}"]`)) {
        // The tag exists but may still be loading; wait for the global.
        const started = Date.now();
        const poll = setInterval(() => {
          if (global.Razorpay) { clearInterval(poll); resolve(global.Razorpay); }
          else if (Date.now() - started > 15000) { clearInterval(poll); reject(new Error('The payment window did not load. Check your connection and try again.')); }
        }, 120);
        return;
      }
      const script = document.createElement('script');
      script.src = CHECKOUT_SCRIPT;
      script.async = true;
      script.onload = () => (global.Razorpay ? resolve(global.Razorpay) : reject(new Error('The payment window did not load.')));
      script.onerror = () => { scriptPromise = null; reject(new Error('The payment window could not be loaded. Check your connection and try again.')); };
      document.head.appendChild(script);
    });
    return scriptPromise;
  }

  /**
   * Which payment method should this screen offer?
   * The answer comes from the server so the two flows can never disagree.
   *
   * `usable` (Razorpay accepted the server's keys) is what gates real payments.
   * `enabled` (the keys are merely non-empty) is NOT enough: a revoked or
   * mistyped key pair passes that test and then fails every order, which left the
   * checkout unable to complete and no fallback offered. The server reports both,
   * and `usable` wins whenever it is present.
   */
  async function getConfig({ refresh = false } = {}) {
    if (refresh) { configPromise = null; cachedConfig = null; }
    if (cachedConfig) return cachedConfig;
    if (!configPromise) {
      const fallback = { enabled: false, usable: false, testModeAvailable: true, testModeLabel: 'Test payment (no gateway configured)', provider: 'unknown', message: 'The payment service could not be reached, so a labelled test payment is used instead. No real money moves.' };
      configPromise = api('/payments/config')
        .then(config => {
          const merged = { testModeAvailable: true, testModeLabel: 'Test payment (no gateway configured)', ...config };
          // Normalise so callers can rely on `usable` even against an older server.
          merged.usable = typeof merged.usable === 'boolean' ? merged.usable : Boolean(merged.enabled);
          cachedConfig = merged;
          return cachedConfig;
        })
        .catch(() => { cachedConfig = { ...fallback }; return cachedConfig; });
    }
    return configPromise;
  }

  /**
   * The live `--brand` colour, so the Razorpay window matches the app in both
   * themes. Previously hard-coded to an indigo that appears nowhere else in the
   * project, which made the payment step look like a different product.
   */
  function brandColour() {
    try {
      const value = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
      return /^#[0-9a-f]{6}$/i.test(value) ? value : '#0f766e';
    } catch {
      return '#0f766e';
    }
  }

  function rupeesFromPaise(paise) {
    return Math.round(Number(paise || 0)) / 100;
  }

  /**
   * Opens the Razorpay checkout for an order the BACKEND created.
   *
   * @param {object} input
   * @param {string} input.path        the verify endpoint, e.g. `/rides/bookings/<id>/verify-payment`
   * @param {string} input.orderPath   the order endpoint, e.g. `/rides/bookings/<id>/payment-order`
   * @param {string} input.bookingId   the latch key
   * @param {string} input.name        payer name
   * @param {string} input.email       payer email
   * @param {string} input.description shown in the checkout
   * @param {number} input.fallbackAmount rupees, only used if the server does not echo an amount
   * @param {string} input.releasePath called when the rider closes the checkout without paying
   * @returns {Promise<{status:string, booking?:object, message?:string}>}
   */
  async function checkout({ orderPath, path, bookingId, name, email, description, fallbackAmount = 0, releasePath }) {
    if (settling.has(bookingId)) return settling.get(bookingId);

    const task = (async () => {
      const config = await getConfig();
      if (!config.usable) return { status: 'unavailable', message: config.message || 'Online payment is not configured on this server.' };

      // The order is created server-side, so the amount can never be forged here.
      const order = await api(orderPath, { method: 'POST', body: {} });
      const Razorpay = await loadCheckoutScript();
      const amount = rupeesFromPaise(order.amount ?? (Math.round(fallbackAmount * 100)));

      return new Promise(resolve => {
        let settled = false;
        const instance = new global.Razorpay({
          key: order.key_id || order.keyId || config.keyId,
          amount: order.amount ?? Math.round(amount * 100),
          currency: order.currency || 'INR',
          order_id: order.order_id || order.id,
          name: 'REVEX',
          description: description || 'REVEX booking',
          prefill: { name: name || '', email: email || '' },
          theme: { color: brandColour() },
          modal: {
            // The rider closed the window. Release the held seats/bookings so
            // inventory is not blocked by an abandoned checkout.
            ondismiss: async () => {
              if (settled) return;
              settled = true;
              if (releasePath) { try { await api(releasePath, { method: 'POST', body: {} }); } catch { /* already released */ } }
              resolve({ status: 'dismissed', message: 'Payment was not completed, so nothing was charged.' });
            }
          },
          handler: async response => {
            if (settled) return;
            settled = true;
            try {
              const result = await api(path, {
                method: 'POST',
                body: {
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature
                }
              });
              resolve({ status: 'paid', booking: result.booking, message: result.message || 'Payment verified.' });
            } catch (error) {
              resolve({ status: 'failed', message: error.message });
            }
          }
        });
        instance.open();
        // `onclose` is the documented event; `modal.ondismiss` above covers the
        // same case, so the latch in both keeps a single resolution.
        if (typeof instance.on === 'function') instance.on('close', () => { /* handled by modal.ondismiss */ });
      });
    })().finally(() => settling.delete(bookingId));

    settling.set(bookingId, task);
    return task;
  }

  /**
   * Records a labelled test payment. Only reachable when the server reports that
   * real payments cannot succeed — either no keys, or keys Razorpay rejects.
   * The server refuses it otherwise.
   */
  async function testPayment({ path, bookingId }) {
    if (settling.has(bookingId)) return settling.get(bookingId);
    const task = (async () => {
      const config = await getConfig();
      if (config.usable) return { status: 'unavailable', message: 'A working payment gateway is configured, so the test payment is disabled.' };
      try {
        const result = await api(path, { method: 'POST', body: {} });
        return { status: 'paid', booking: result.booking, message: result.message || 'Test payment recorded.', testMode: true };
      } catch (error) {
        return { status: 'failed', message: error.message };
      }
    })().finally(() => settling.delete(bookingId));
    settling.set(bookingId, task);
    return task;
  }

  /** True when this booking is currently being settled. */
  function isSettling(bookingId) {
    return settling.has(bookingId);
  }

  /**
   * Standard handler for a "Pay & Book Ride" style button.
   * Shows the correct feedback, never a fake success, and re-enables the button.
   */
  async function settle(button, options) {
    if (!button || button.disabled) return null;
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="rvx-spinner" aria-hidden="true"></span> Processing payment…';
    try {
      const config = await getConfig();
      const result = config.usable
        ? await checkout(options)
        : await testPayment({ path: options.testPath, bookingId: options.bookingId });
      if (result.status === 'paid') showToast(result.message, 'ok');
      else if (result.status === 'unavailable') showToast(result.message, 'warn', 8000);
      else if (result.status === 'dismissed') showToast(result.message, 'warn');
      else showToast(result.message || 'The payment could not be completed.', 'bad', 8000);
      return result;
    } catch (error) {
      showToast(error.message, 'bad', 8000);
      return { status: 'failed', message: error.message };
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  global.RevexPay = { getConfig, checkout, testPayment, settle, isSettling, loadCheckoutScript };
})(window);

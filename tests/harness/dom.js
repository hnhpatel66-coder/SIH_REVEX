/**
 * A very small DOM harness, just enough to run js/rental.js in Node.
 *
 * It exists so the price-breakdown behaviour can be tested offline and
 * deterministically. The bug it was written for was invisible to the API tests
 * (the server always returned a correct quote) and invisible to review, and it
 * only appeared when the dates were edited one field at a time - which is how
 * every real person types. Reproducing that needed a real event loop and a real
 * form, so here is a real form and a real event loop, minus the browser.
 *
 * Not a general-purpose DOM. It supports exactly what rental.js touches.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** The project root, so scripts resolve to <root>/js regardless of who calls in. */
const ROOT = path.join(__dirname, '..', '..');

/** Elements this harness understands. */
class El {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = { ...attrs };
    this.children = [];
    this.listeners = {};
    this._value = attrs.value !== undefined ? String(attrs.value) : '';
    this.checked = Boolean(attrs.checked);
    this.disabled = Boolean(attrs.disabled);
    this.hidden = Boolean(attrs.hidden);
    this.dataset = {};
    this.className = '';
    this.id = attrs.id || '';
    this.name = attrs.name || '';
    this.type = attrs.type || '';
    this.innerHTML = '';
    this.textContent = '';
    this.style = {};
    this.classList = {
      _set: new Set(String(attrs.class || '').split(' ').filter(Boolean)),
      add: (...names) => names.forEach(n => this.classList._set.add(n)),
      remove: (...names) => names.forEach(n => this.classList._set.delete(n)),
      contains: name => this.classList._set.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classList._set.has(name) : force;
        if (on) this.classList._set.add(name); else this.classList._set.delete(name);
        return on;
      }
    };
  }
  get value() { return this._value; }
  set value(v) { this._value = v === undefined || v === null ? '' : String(v); }

  /**
   * Wraps this element so unknown property reads resolve to a child control, the
   * way a real HTMLFormElement does.
   *
   * The app relies on that constantly: `form.startDate`, `form.startTime`,
   * `form.estimatedKm`. A plain class cannot do it, because a method named `get`
   * is not a property getter, so a Proxy is used. Without it `form.startDate`
   * was `undefined`, `setSafeBookingDefaults()` set nothing, no quote was ever
   * requested, and the page silently did nothing.
   */
  asForm() {
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
        if (prop in target) return Reflect.get(target, prop, receiver);
        const child = target.children.find(c => (c.name && c.name === prop) || (c.id && c.id === prop));
        return child === undefined ? undefined : child;
      }
    });
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn);
  }
  /** Fires a real bubbling event, exactly like a keystroke would. */
  async dispatch(type) {
    const event = { type, target: this, bubbles: true, preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false };
    let node = this;
    while (node) {
      for (const fn of (node.listeners && node.listeners[type]) || []) await fn.call(node, event);
      node = node.parentElement;
    }
    return event;
  }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  replaceChildren(...kids) { this.children = kids; kids.forEach(k => { k.parentElement = this; }); }
  setAttribute(name, value) { this.attributes[name] = value; if (name === 'hidden') this.hidden = true; }
  getAttribute(name) { return this.attributes[name] === undefined ? null : this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get innerText() { return this.textContent || stripTags(this.innerHTML); }
  focus() {}
  closest() { return null; }
}
function stripTags(html) { return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

/**
 * Builds the document, the window and the location, loads the given scripts in
 * order, and fires DOMContentLoaded.
 *
 * @param {object} options
 * @param {Array<{id:string, tag?:string, attrs?:object}>} options.elements
 * @param {Array<string>} options.scripts   file names under js/, in load order
 * @param {object} options.env               the fake window.REVEX
 * @param {function} options.fetchImpl      (url, options) => {status, body}
 * @param {string} [options.search]          location.search
 */
function mountHarness({ elements = [], scripts = [], env = {}, fetchImpl, search = '', href = 'http://localhost:5001/vehicle-details.html' } = {}) {
  const byId = new Map();
  const body = new El('body');
  for (const spec of elements) {
    const el = new El(spec.tag || 'input', spec.attrs || { id: spec.id });
    el.id = spec.id;
    el.name = (spec.attrs && spec.attrs.name) || spec.id;
    byId.set(spec.id, el);
    body.appendChild(el);
  }
  // A form that owns the date/time/km controls, so events bubble like the real page.
  const form = new El('form', { id: 'rentalBooking', method: 'post' });
  byId.set('rentalBooking', form);
  ['startDate', 'startTime', 'endDate', 'endTime', 'estimatedKm', 'panNumber', 'drivingLicenseNumber']
    .forEach(id => { if (!byId.has(id)) { const el = new El('input', { id }); el.id = el.name = id; byId.set(id, el); form.appendChild(el); } });
  const button = new El('button', { id: 'submit', type: 'submit' });
  form.appendChild(button);
  const consent = new El('input', { id: 'agreementConsent', type: 'checkbox' });
  byId.set('agreementConsent', consent);
  form.appendChild(consent);
  body.appendChild(form);
  // Registered as a form, so `form.startDate` resolves to the control like it
  // does in a browser. rental.js depends on that in setSafeBookingDefaults().
  const formProxy = form.asForm();
  byId.set('rentalBooking', formProxy);

  const calls = [];
  const location = { origin: 'http://localhost:5001', href, search, pathname: '/vehicle-details.html', hostname: 'localhost', port: '5001', protocol: 'http:', replace() {} };

  const document = {
    body,
    documentElement: new El('html'),
    title: '',
    readyState: 'complete',
    getElementById: id => byId.get(id) || null,
    querySelector(sel) {
      /*
       * Descendant queries, e.g. `#rentalBooking button[type="submit"]`, which is
       * how updateQuoteButton() finds the booking button. Only the two shapes
       * the app actually uses are supported; anything else returns null, so a
       * test can never pass by accidentally matching the wrong element.
       */
      const descendant = /^#([\w-]+)\s+(\w+)(?:\[(\w+)(?:=["']?([^\]"']*)["']?)?\])?$/.exec(sel.trim());
      if (descendant) {
        const host = byId.get(descendant[1]);
        if (!host) return null;
        const [, , tag, attr, value] = descendant;
        return host.children.find(child => {
          if (child.tagName !== tag.toUpperCase()) return false;
          if (!attr) return true;
          const actual = child.getAttribute(attr);
          return value === undefined ? Boolean(actual) : String(actual) === value;
        }) || null;
      }
      if (sel.startsWith('#')) return byId.get(sel.slice(1)) || null;
      return null;
    },
    querySelectorAll: () => [],
    createElement: tag => new El(tag),
    createTextNode: text => { const n = new El('#text'); n.textContent = text; return n; },
    addEventListener(type, fn) { (this._l = this._l || {})[type] = (this._l[type] || []).concat(fn); },
    async fire(type) { for (const fn of (this._l && this._l[type]) || []) await fn({ type, preventDefault() {} }); }
  };

  /*
   * A quiet console for the page under test.
   *
   * rental.js warns every time the server rejects a half-typed window, which
   * happens on purpose in these tests, so the raw warnings drown the results.
   * Real errors are still printed, and anything can be re-enabled with
   * REVERBOSE_TESTS=1 when a failure needs investigating.
   */
  const verbose = process.env.REVERBOSE_TESTS === '1';
  const pageConsole = {
    log: (...args) => console.log('[page]', ...args),
    info: (...args) => console.log('[page]', ...args),
    warn: (...args) => { if (verbose) console.warn('[page]', ...args); },
    error: (...args) => console.error('[page]', ...args),
    debug: () => {}
  };

  const win = {
    REVEX: {
      api: async (url, options) => {
        calls.push({ url, options });
        const result = await fetchImpl(url, options);
        if (result.status >= 400) throw new Error((result.body && result.body.message) || 'request failed');
        return result.body;
      },
      escapeHtml: v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
      formatMoney: v => '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      formatDate: v => String(v),
      formatDateTime: v => String(v),
      assetUrl: v => String(v),
      getStoredUser: () => ({ name: 'Test Renter', role: 'user' }),
      getToken: () => 'test-token',
      requireLogin: () => true,
      requireRole: () => true,
      showModal: () => {},
      showToast: () => {},
      imageOrInitials: () => '',
      statusBadge: () => '',
      ...env
    },
    location,
    document,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    pageConsole,
    URLSearchParams,
    URL,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => ({ ok: true, status: 200, json: async () => ({}) })
  };
  win.window = win;
  win.globalThis = win;

  for (const file of scripts) {
    const source = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'location', 'console', 'fetch', 'localStorage', 'URLSearchParams', 'URL', source)(win, document, location, pageConsole, win.fetch, win.localStorage, URLSearchParams, URL);
  }

  return { window: win, document, byId, form, calls, location, button, consent };
}

module.exports = { mountHarness, El };

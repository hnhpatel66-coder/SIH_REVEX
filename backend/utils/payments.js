/**
 * RAZORPAY GATEWAY CLIENT  (backend/utils/payments.js)
 *
 * One implementation of the Razorpay Standard Checkout REST contract, shared by
 * the rental flow (backend/routes/bookings.js) and the ride flow
 * (backend/routes/rides.js). Before this module each route had its own copy, and
 * the ride flow had none at all.
 *
 * Design rules that this file exists to enforce:
 *  - The SECRET key is read from the environment and never leaves the server.
 *  - Order amounts are computed by the backend. There is no code path that
 *    accepts an amount from the browser.
 *  - Signature comparison is length-checked and constant-time.
 *  - A gateway failure is surfaced with a useful message, never a fake success.
 *
 * No npm dependency is required: the REST calls are made over node:https, so the
 * project installs and runs even when the optional `razorpay` SDK is absent.
 */
const https = require('https');
const crypto = require('crypto');

const HOST = 'api.razorpay.com';
const API_VERSION = 'v1';
const TIMEOUT_MS = 20000;

/**
 * Maps a Razorpay HTTP status onto a status for THIS api.
 *
 * The important rule: 401 is NEVER passed through.
 *
 * Razorpay answers 401 when *the server's own* key id/secret pair is wrong. The
 * earlier version forwarded that as our 401, and the browser — which treats any
 * 401 on an authenticated request as an expired session — logged the customer
 * out mid-checkout and showed "your session expired". A server misconfiguration
 * was therefore reported as the rider's fault, and the real cause was invisible.
 *
 * An upstream credential failure is a bad gateway, so it becomes 502 with an
 * actionable message naming the two env variables.
 */
function mapUpstreamStatus(upstreamStatus) {
  if (upstreamStatus === 400) return 400;   // the request we sent was malformed
  if (upstreamStatus === 429) return 429;   // Razorpay rate limit; pass through so a retry is honest
  return 502;                               // 401, 403, 404, 5xx, anything else
}

const CREDENTIALS_MESSAGE = 'Razorpay rejected this server\'s API credentials. This is a server configuration problem, not your account: check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the backend .env file and restart the server. Your session is unaffected and no money has moved.';

class GatewayError extends Error {
  constructor(message, { status = 502, code = 'GATEWAY_ERROR', description = '' } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.statusCode = status;
    this.code = code;
    this.description = description;
  }
}

function isConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

/** The public key id is safe to hand to the browser. The secret never is. */
function publicConfig() {
  return {
    provider: 'razorpay',
    enabled: isConfigured(),
    keyId: isConfigured() ? process.env.RAZORPAY_KEY_ID : '',
    currency: process.env.RAZORPAY_CURRENCY || 'INR'
  };
}

function request(method, path, body) {
  if (!isConfigured()) {
    throw new GatewayError('Razorpay is not configured on this server. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.', { status: 503, code: 'NOT_CONFIGURED' });
  }
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const payload = body === undefined || body === null ? '' : JSON.stringify(body);
    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };
    if (payload) headers['Content-Type'] = 'application/json';

    const req = https.request({ hostname: HOST, path: `/${API_VERSION}${path}`, method, headers, timeout: TIMEOUT_MS }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch { parsed = {}; }
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(parsed);
        const upstreamMessage = parsed?.error?.description || parsed?.message || '';
        const credentialsRejected = response.statusCode === 401 || response.statusCode === 403;
        const description = credentialsRejected
          ? CREDENTIALS_MESSAGE
          : (upstreamMessage || `Payment gateway error (${response.statusCode}).`);
        return reject(new GatewayError(description, {
          // Never 401: see mapUpstreamStatus.
          status: mapUpstreamStatus(response.statusCode),
          code: credentialsRejected ? 'GATEWAY_CREDENTIALS_REJECTED' : (parsed?.error?.code || 'GATEWAY_ERROR'),
          description,
          upstreamStatus: response.statusCode
        }));
      });
    });
    req.on('timeout', () => { req.destroy(new GatewayError('The payment gateway did not respond in time.', { status: 504, code: 'GATEWAY_TIMEOUT' })); });
    req.on('error', error => {
      if (error instanceof GatewayError) return reject(error);
      return reject(new GatewayError(error.code === 'ENOTFOUND' ? 'The payment gateway could not be reached. Check the server network.' : error.message, { status: 502, code: 'GATEWAY_UNREACHABLE' }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Rupees -> paise. Razorpay works in the smallest currency unit. */
function toPaise(rupees) {
  return Math.round(Number(rupees || 0) * 100);
}

function toRupees(paise) {
  return Math.round(Number(paise || 0)) / 100;
}

/**
 * Creates a Razorpay order for a backend-computed amount.
 * @param {{amount:number, receipt:string, notes?:object}} input amount in RUPEES
 */
async function createOrder({ amount, receipt, notes }) {
  const paise = toPaise(amount);
  if (!Number.isInteger(paise) || paise < 100) {
    throw new GatewayError('The payable amount must be at least ₹1.', { status: 400, code: 'AMOUNT_TOO_SMALL' });
  }
  const order = await request('POST', '/orders', {
    amount: paise,
    currency: process.env.RAZORPAY_CURRENCY || 'INR',
    receipt: String(receipt || '').slice(0, 40),
    ...(notes ? { notes: Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, String(v).slice(0, 256)])) } : {})
  });
  return { id: order.id, amount: order.amount, currency: order.currency, receipt: order.receipt, status: order.status, keyId: process.env.RAZORPAY_KEY_ID };
}

/**
 * Fetches an order so a verification callback can be checked against Razorpay.
 *
 * Razorpay ids are `order_` / `pay_` followed by a base62 token. The token has
 * been observed both with and without an underscore, so both are accepted; the
 * earlier `[A-Za-z0-9]+` pattern rejected a legitimate id and turned a real
 * payment into "that payment order reference is not valid".
 */
async function fetchOrder(orderId) {
  if (!/^order_[A-Za-z0-9_]+$/.test(String(orderId || ''))) {
    throw new GatewayError('That payment order reference is not valid.', { status: 400, code: 'BAD_ORDER_ID' });
  }
  return request('GET', `/orders/${orderId}`);
}

/* ------------------------------------------------------------- health check */

/**
 * A cached, one-credential-call probe that answers "can this server actually
 * take a payment right now?".
 *
 * `isConfigured()` only proves the two variables are non-empty. A revoked,
 * mistyped or mismatched key pair passes that test and then fails every real
 * order with a 401 — which is the state this project was in, and it left the
 * app with no way to pay at all and no way to tell the operator why.
 *
 * The result drives `/api/payments/config`, which is what lets the UI offer the
 * labelled test payment instead of a checkout that cannot succeed.
 */
const HEALTH_TTL_MS = Number(process.env.RAZORPAY_HEALTH_TTL_MS) > 0
  ? Number(process.env.RAZORPAY_HEALTH_TTL_MS)
  : 5 * 60 * 1000;
let healthCache = { at: 0, value: null };

async function checkHealth({ force = false } = {}) {
  if (!isConfigured()) {
    const value = {
      usable: false,
      state: 'missing',
      message: 'Razorpay keys are not set on this server, so a labelled test payment is used instead. No real money moves.'
    };
    healthCache = { at: Date.now(), value };
    return value;
  }
  if (!force && healthCache.value && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.value;

  let value;
  try {
    // A read-only list call: it authenticates the key pair without creating,
    // capturing or cancelling anything.
    const result = await request('GET', '/orders?count=1');
    value = {
      usable: true,
      state: 'ready',
      message: 'Razorpay is connected. Payments are verified by the server before a booking is confirmed.'
    };
    if (Array.isArray(result?.items)) value.reachable = true;
  } catch (error) {
    const rejected = error.code === 'GATEWAY_CREDENTIALS_REJECTED';
    value = {
      usable: false,
      state: rejected ? 'rejected' : 'unreachable',
      code: error.code,
      message: rejected
        ? CREDENTIALS_MESSAGE
        : `Razorpay could not be reached from this server (${error.message}). A labelled test payment is used instead. No real money moves.`
    };
  }
  healthCache = { at: Date.now(), value };
  return value;
}

/** Constant-time HMAC comparison. Never throws on a malformed signature. */
function signaturesMatch(expected, received) {
  const left = String(expected || '');
  const right = String(received || '');
  if (!right || !/^[a-f0-9]+$/i.test(right) || right.length !== left.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
  catch { return false; }
}

/** `order_id|payment_id` signed with the secret key. */
function expectedSignature(orderId, paymentId) {
  if (!process.env.RAZORPAY_KEY_SECRET) throw new GatewayError('Razorpay is not configured on this server.', { status: 503, code: 'NOT_CONFIGURED' });
  return crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

/**
 * Full server-side verification of a checkout callback.
 * Returns `{ ok, reason, payment, order }` and never throws for a bad signature,
 * so the caller can record a failed attempt before answering the browser.
 */
async function verifyCheckout({ orderId, paymentId, signature, expectedAmountPaise }) {
  if (!orderId || !paymentId || !signature) {
    return { ok: false, reason: 'Payment verification data is incomplete.' };
  }
  if (!signaturesMatch(expectedSignature(orderId, paymentId), signature)) {
    return { ok: false, reason: 'Payment signature verification failed.' };
  }
  let order;
  try { order = await fetchOrder(orderId); }
  catch (error) { return { ok: false, reason: error.message, gatewayError: error }; }

  if (order.id !== orderId) return { ok: false, reason: 'The payment order does not match this booking.' };
  if (!['paid', 'captured', 'authorized'].includes(String(order.status || ''))) {
    return { ok: false, reason: `Razorpay reports the order as "${order.status}". Payment was not completed.` };
  }
  const paidPaise = order.amount_paid ?? order.amount;
  if (expectedAmountPaise !== undefined && Number(expectedAmountPaise) !== 0 && Number(paidPaise) !== Number(expectedAmountPaise)) {
    return { ok: false, reason: 'The amount collected does not match the amount due for this booking.' };
  }
  return { ok: true, order, payment: { id: String(paymentId), amount: toRupees(paidPaise), currency: order.currency, method: order.payment_method || '' } };
}

/**
 * Refunds a captured payment. `amount` is in rupees; omit it for a full refund.
 * A gateway failure is returned as `{ ok:false }` so the caller can record the
 * attempt and let an operator finish it manually — never silently dropped.
 */
async function refund({ paymentId, amount, receipt, notes }) {
  if (!isConfigured()) return { ok: false, reason: 'Razorpay is not configured on this server.', status: 503 };
  if (!/^pay_[A-Za-z0-9_]+$/.test(String(paymentId || ''))) {
    return { ok: false, reason: 'This booking has no Razorpay payment reference to refund.', status: 400 };
  }
  const body = { speed: process.env.RAZORPAY_REFUND_SPEED || 'normal' };
  if (amount !== undefined && amount !== null) {
    const paise = toPaise(amount);
    if (paise < 1) return { ok: false, reason: 'The refund amount must be greater than zero.', status: 400 };
    body.amount = paise;
  }
  if (receipt) body.receipt = String(receipt).slice(0, 40);
  if (notes) body.notes = Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, String(v).slice(0, 256)]));
  try {
    const result = await request('POST', `/payments/${paymentId}/refund`, body);
    return { ok: true, refund: { id: result.id, amount: toRupees(result.amount), currency: result.currency, status: result.status, receipt: result.receipt || '' } };
  } catch (error) {
    return { ok: false, reason: error.message, status: error.statusCode || 502 };
  }
}

module.exports = {
  GatewayError,
  CREDENTIALS_MESSAGE,
  mapUpstreamStatus,
  isConfigured,
  publicConfig,
  checkHealth,
  request,
  createOrder,
  fetchOrder,
  verifyCheckout,
  expectedSignature,
  signaturesMatch,
  refund,
  toPaise,
  toRupees
};

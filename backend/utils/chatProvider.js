/**
 * CHAT PROVIDER  (backend/utils/chatProvider.js)
 *
 * Resolves which assistant backend to call and speaks its request format.
 * Extracted from routes/chat.js so it can be unit-tested offline, and so the
 * "is it configured?" answer has exactly one implementation.
 *
 * WHY THIS FILE EXISTS (the bug it fixes)
 *
 * The first version computed:
 *
 *     configured = Boolean(CHAT_API_KEY && CHAT_API_URL)
 *
 * A Google AI Studio key on its own therefore reported the assistant as "not
 * configured" and every message returned HTTP 503, even though the key was
 * valid and a direct call to Gemini returned 200. The reason was that the
 * endpoint URL is a *derivable* constant, yet it was treated as a second
 * mandatory secret. Anyone who pasted only `GEMINI_API_KEY=` — which is all the
 * setup notes ever asked for — got a dead chatbot and a misleading error.
 *
 * The rules now:
 *   1. `CHAT_API_KEY` (or the legacy `GEMINI_API_KEY`) is the only secret.
 *   2. `CHAT_API_URL` is optional. When it is absent and the key looks like a
 *      Google AI Studio key, the official :generateContent endpoint is built
 *      from the model name.
 *   3. When a URL IS given it may be a full endpoint, a `…/models` base, or a
 *      bare base — it is completed rather than blindly used.
 *   4. `GEMINI_API_KEY` / `GEMINI_MODEL` remain accepted so existing .env
 *      files keep working unchanged.
 */
'use strict';

const TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS) > 0
  ? Number(process.env.CHAT_TIMEOUT_MS)
  : 20000;

/** Google's public Gemini REST base. Not a secret. */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_MODEL = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `
You are the REVEX Assistant, the in-app support assistant for REVEX, a transportation platform that combines vehicle rental and ride sharing.

Your role:
- Help riders, owners and administrators understand and use REVEX.
- Focus on ride sharing, vehicle rental, bookings, payments, cancellations and refunds, accounts and profiles, owners, agreements, feedback and basic support.
- Keep answers concise, friendly and practical.
- Write PLAIN TEXT ONLY. Do not use markdown, asterisks, hash headings, bullet characters, backticks, bold or italic syntax, and do not repeat the question. The transcript renders text literally, so "**bold**" is shown to the user with the asterisks still attached. Use short paragraphs and ordinary sentences instead.
- If the user writes in Gujarati, answer in Gujarati. In Hindi, answer in Hindi. Otherwise answer in clear English.
- Never claim a booking, payment, cancellation, refund, approval or account change happened unless the application itself confirms it. You cannot see the database.
- Never ask for, or repeat, passwords, OTPs, card PINs, CVVs, API keys or JWT secrets.
- For payment problems, give safe troubleshooting steps and point to the official REVEX flow. Never ask for card details.
- If a question is unrelated to REVEX, explain politely that you are the REVEX Assistant.

REVEX knowledge:
1. Ride sharing (Find a Ride)
   - Owners publish ride offers: route, date, time, seats, price per seat and vehicle.
   - An admin approves the OFFER before it appears publicly. This is separate from the owner approving a rider.
   - A rider picks seats, sees a backend-calculated total, then pays immediately with "Pay & Book Ride".
   - Payment is only successful after the backend verifies the Razorpay signature.
   - After payment the seat request waits for the owner, who approves or rejects it. A rejection refunds the rider under the cancellation policy.
   - Ride availability is seats minus seats already held by live bookings, so a ride can never be overbooked.

2. Vehicle rental (Rent a Vehicle)
   - Owners register a vehicle with a photo and documents; an admin approves it.
   - Renters book dates, accept the agreement and pay.
   - The owner then accepts or declines the request. A decline refunds the renter under the cancellation policy.

3. Payments
   - REVEX uses Razorpay Standard Checkout. The backend creates the order and verifies the callback.
   - If Razorpay is not configured on the server, the payment screen offers a clearly labelled test payment that is stored as a "demo" payment, never as real money.
   - The total is always calculated by the backend, never by the browser.

4. Cancellations and refunds
   - Any user, owner or admin can cancel where the rules allow.
   - The cancellation fee and the refund come from a single configurable policy (free-cancellation window, percentage and flat fee, per-cancellation ceiling).
   - Records are never deleted. A cancelled booking keeps its status, reason and refund details for the audit trail.

5. Accounts
   - Register, log in, edit profile details and a profile photo, change password, log out.
   - Switch to an owner account from the Profile page to list vehicles and offer rides.

6. Admin
   - Admin reviews vehicle verification, ride approvals, the Owner Summary dashboard, bookings, payments and reports.
   - Never reveal or guess admin credentials or private configuration.

Navigation: Home, Find a Ride, Rent a Vehicle, My Bookings, Offer a Ride, List a Vehicle, Ride Requests, Profile, Chat, and the Admin Dashboard.
`;

function cleanText(value, max = 2000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

/**
 * Whether a key looks like a Google AI key rather than an OpenAI-style one.
 *
 * This is only used to phrase the error message, NEVER to decide whether the
 * Gemini endpoint can be derived. Google has shipped more than one key format
 * (the older `AIza…` and the newer `AQ.…`), so gating on a prefix rejected a
 * key that demonstrably worked: the assistant reported "not configured" while a
 * direct call to the same key returned 200. Deriving optimistically and letting
 * the provider answer is the only reliable test.
 */
function isGoogleAiKey(key) {
  const value = String(key || '');
  if (!value) return false;
  if (/^sk[-_]/i.test(value)) return false;   // clearly OpenAI-style
  return true;
}

/**
 * Completes a user-supplied endpoint into a real API endpoint.
 *
 * Accepts, and normalises:
 *   https://host/v1/chat/completions          -> unchanged (OpenAI dialect)
 *   https://host/v1                          -> https://host/v1/chat/completions
 *   https://host/v1beta/models               -> https://host/v1beta/models/<model>:generateContent
 *   https://host/v1beta/models/gemini-x:generateContent -> unchanged
 */
function normaliseEndpoint(rawUrl, model) {
  const raw = cleanText(rawUrl, 500);
  if (!raw) return '';
  const [base] = raw.split('?');
  const trimmed = base.replace(/\/+$/, '');
  if (!trimmed) return '';

  // Already a concrete endpoint, so leave it alone. This covers both shapes:
  //   a Gemini `:generateContent` suffix, and an OpenAI `/chat/completions`
  //   path segment. Testing only for the colon form appended `/chat/completions`
  //   a second time to a perfectly valid OpenAI URL.
  if (/:[a-zA-Z]+$/.test(trimmed)) return raw;
  if (/\/(chat\/completions|completions|messages)$/i.test(trimmed)) return raw;

  // A `…/models` base is a Gemini base; strip the segment and rebuild.
  if (/\/models$/i.test(trimmed)) {
    return `${trimmed.replace(/\/models$/i, '')}/models/${encodeURIComponent(model)}:generateContent`;
  }
  // A bare API version root is an OpenAI-compatible base.
  return `${trimmed}/chat/completions`;
}

/**
 * Refuses to send the API key over plain HTTP to a remote host. A mis-typed
 * `http://` would otherwise leak the key on the first request.
 */
function isTransportSafe(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** The whole provider decision, derived from the environment. Pure and testable. */
function providerConfig(env = process.env) {
  const apiKey = cleanText(env.CHAT_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY, 300);
  const model = cleanText(env.CHAT_API_MODEL || env.GEMINI_MODEL, 120) || DEFAULT_MODEL;
  const rawUrl = cleanText(env.CHAT_API_URL, 500);

  let url = '';
  let derived = false;
  if (rawUrl) {
    url = normaliseEndpoint(rawUrl, model);
  } else if (apiKey) {
    // The fix: a bare key is enough. The endpoint is a constant, and the
    // provider itself is the only reliable judge of whether the key is good.
    url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    derived = true;
  }

  const secure = url ? isTransportSafe(url) : true;
  const dialect = /\/chat\/completions/i.test(url) ? 'openai' : 'gemini';

  return {
    configured: Boolean(apiKey && url && secure),
    /** Why it is unusable, for the UI. Empty when configured. */
    problem: !apiKey
      ? 'No assistant API key is set.'
      : !url
        ? 'No assistant endpoint is set, and the key is not a Google AI Studio key, so the endpoint cannot be derived. Set CHAT_API_URL to your provider\'s endpoint.'
        : !secure
          ? 'CHAT_API_URL must use https (http is only allowed for localhost).'
          : '',
    url,
    derivedUrl: derived,
    model,
    apiKey,
    dialect,
    secure,
    maxOutputTokens: Math.min(4000, Math.max(120, Number(env.CHAT_MAX_OUTPUT_TOKENS) || 450)),
    temperature: Math.min(2, Math.max(0, Number(env.CHAT_TEMPERATURE) || 0.35))
  };
}

/** Appends the key to a Gemini URL without ever logging it. */
function withKey(url, apiKey) {
  return /[?&]key=/i.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
}

function errorDetail(data, status) {
  return data?.error?.message
    || data?.error?.description
    || (typeof data?.message === 'string' ? data.message : '')
    || `Chat provider error (${status}).`;
}

/**
 * Classifies a provider failure so the user is told what actually happened.
 *
 * The earlier version collapsed every failure into "temporarily unavailable",
 * which is actively unhelpful: an exhausted daily free-tier quota looks exactly
 * like an outage, so nobody could tell whether to wait, upgrade, or fix a key.
 * Each kind below needs a different action, so each gets its own message.
 *
 *   quota       the account is out of requests; retrying in a minute will not help
 *   rateLimit   too many requests in a short window; retry in seconds
 *   credentials the API key is wrong or not authorised; only the operator can fix it
 *   provider    anything else upstream
 */
function classifyFailure(providerStatus, detail) {
  const text = String(detail || '');
  if (/quota|free_tier|insufficient_quota|billing|exceeded your current/i.test(text)) return 'quota';
  if (providerStatus === 429 || /rate limit|rate-limit|too many requests/i.test(text)) return 'rateLimit';
  if (providerStatus === 401 || providerStatus === 403 || /api key not valid|unauthori[sz]ed|permission denied/i.test(text)) return 'credentials';
  return 'provider';
}

/** Seconds to wait, when the provider says so ("Please retry in 42.4s"). */
function retryAfterSeconds(detail) {
  const match = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(String(detail || ''));
  return match ? Math.max(1, Math.ceil(Number(match[1]))) : 0;
}

/** The message the signed-in user sees, per failure kind. */
function userMessage(kind, retryAfter) {
  switch (kind) {
    case 'quota':
      return 'The REVEX Assistant has used up its request quota for now. Please try again later today.';
    case 'rateLimit': {
      // The provider's own hint, rounded to a whole 5s. Rounding UP to the next
      // 30s boundary was tried and made the advice worse: told to wait 60s for a
      // 45s limit, people stop trusting the number.
      const seconds = Math.max(5, Math.ceil((retryAfter || 30) / 5) * 5);
      return `The REVEX Assistant is handling too many requests right now. Please try again in about ${seconds} seconds.`;
    }
    case 'credentials':
      return 'The REVEX Assistant could not sign in to its provider. The server operator needs to check the assistant API key in the backend .env file.';
    case 'timeout':
      return 'The REVEX Assistant took too long to respond. Please try again.';
    default:
      return 'The REVEX Assistant is temporarily unavailable. Please try again shortly.';
  }
}

/**
 * Calls the provider.
 * Returns `{ ok:true, reply }` or `{ ok:false, status, detail, kind, retryAfter }`
 * and never throws for a provider problem, so the caller can record the attempt.
 *
 * `status` is always an HTTP status for THIS api, never the provider's raw code:
 * an upstream 401 means our key is bad, which is a server misconfiguration (502)
 * and must not be confused with a signed-in user whose session expired.
 */
async function callProvider(config, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const fail = (status, detail, providerStatus, kind) => ({
    ok: false,
    status,
    detail,
    providerStatus,
    kind: kind || classifyFailure(providerStatus, detail),
    retryAfter: retryAfterSeconds(detail)
  });

  try {
    if (config.dialect === 'openai') {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
          temperature: config.temperature,
          max_tokens: config.maxOutputTokens
        }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return fail(502, errorDetail(data, response.status), response.status);
      const reply = data?.choices?.[0]?.message?.content;
      if (!reply) return fail(502, 'The assistant returned an empty reply.', response.status);
      return { ok: true, reply: String(reply).trim() };
    }

    const response = await fetch(withKey(config.url, config.apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages.map(entry => ({
          role: entry.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: entry.text }]
        })),
        generationConfig: { temperature: config.temperature, maxOutputTokens: config.maxOutputTokens }
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return fail(502, errorDetail(data, response.status), response.status);
    const parts = data?.candidates?.[0]?.content?.parts;
    const reply = Array.isArray(parts) ? parts.map(part => part?.text || '').join('').trim() : '';
    if (!reply) {
      // Gemini reports a filtered/empty candidate block with HTTP 200.
      const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
      return fail(502, reason ? `The assistant could not answer (${reason}).` : 'The assistant returned an empty reply.', response.status);
    }
    return { ok: true, reply };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, status: 504, detail: 'The assistant took too long to respond.', kind: 'timeout', retryAfter: 0 };
    return { ok: false, status: 502, detail: `Could not reach the assistant: ${error.message}`, kind: 'provider', retryAfter: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** The payload behind GET /api/chat/status. */
function describeStatus(env = process.env) {
  const config = providerConfig(env);
  return {
    configured: config.configured,
    provider: config.dialect === 'openai' ? 'openai-compatible' : 'gemini',
    model: config.configured ? config.model : '',
    // The host and path are safe to show; the key never is.
    endpoint: config.configured ? config.url.replace(/([?&]key=)[^&]*/i, '$1***') : '',
    endpointDerived: config.derivedUrl,
    message: config.configured
      ? 'The REVEX Assistant is ready.'
      : `${config.problem} Add the assistant key and endpoint to the backend .env file, then restart the server.`
  };
}

module.exports = {
  SYSTEM_PROMPT,
  GEMINI_BASE,
  DEFAULT_MODEL,
  TIMEOUT_MS,
  isGoogleAiKey,
  normaliseEndpoint,
  isTransportSafe,
  providerConfig,
  callProvider,
  classifyFailure,
  retryAfterSeconds,
  userMessage,
  describeStatus,
  cleanText
};

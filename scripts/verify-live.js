/**
 * End-to-end check of the two integrations against the LIVE server on 5001.
 *   node scripts/verify-live.js
 * Registers a throwaway account, then exercises /api/chat and /api/payments/config.
 */
'use strict';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5001';
const stamp = Date.now();
const EMAIL = `probe${stamp}@revex.test`;
const PASSWORD = 'Probe!Pass123';

/**
 * The real secret values, read from backend/.env, so a leak check compares
 * against the actual strings rather than guessing at their shape.
 */
const secrets = (() => {
  try {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'backend', '.env'), 'utf8');
    return ['RAZORPAY_KEY_SECRET', 'GEMINI_API_KEY', 'CHAT_API_KEY', 'JWT_SECRET']
      .map(name => {
        const match = new RegExp(`^${name}\\s*=\\s*(.+)$`, 'm').exec(source);
        return match ? match[1].trim() : '';
      })
      .filter(value => value.length > 8);
  } catch {
    return [];
  }
})();

let token = '';

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  return { status: response.status, data };
}

(async () => {
  console.log(`target: ${BASE}\n`);

  /* ---------------------------------------------------------- payments */
  console.log('=== /api/payments/config ===');
  const config = await call('/payments/config', { auth: false });
  const raw = JSON.stringify(config.data);
  console.log('  status          :', config.status);
  console.log('  enabled         :', config.data.enabled, '(keys are present)');
  console.log('  usable          :', config.data.usable, '(Razorpay accepted them)');
  console.log('  state           :', config.data.state);
  console.log('  testModeAvailable:', config.data.testModeAvailable);
  console.log('  label           :', config.data.testModeLabel);
  console.log('  message         :', String(config.data.message).slice(0, 110) + '…');
  // The publishable key id IS meant to reach the browser; the secret is not.
  // Checking for the word "SECRET" would false-positive on the guidance text,
  // which names the variable to fix, so compare against the real values.
  console.log('  publishable keyId returned:', Boolean(config.data.keyId), '(required by Razorpay Checkout)');
  console.log('  any key-shaped value leaked :', secrets.every(value => !raw.includes(value)) ? 'no' : 'YES');

  /* -------------------------------------------------------------- chat */
  console.log('\n=== register + sign in ===');
  const reg = await call('/auth/register', {
    method: 'POST', auth: false,
    body: { name: 'Probe User', email: EMAIL, password: PASSWORD, phone: '9999999999' }
  });
  if (reg.status === 201 && reg.data.token) token = reg.data.token;
  else {
    const login = await call('/auth/login', { method: 'POST', auth: false, body: { email: EMAIL, password: PASSWORD } });
    token = login.data.token || '';
  }
  console.log('  signed in       :', Boolean(token));
  if (!token) { console.log('  cannot continue without a session'); return; }

  console.log('\n=== /api/chat/status ===');
  const status = await call('/chat/status');
  console.log('  status          :', status.status);
  console.log('  configured      :', status.data.configured);
  console.log('  provider        :', status.data.provider);
  console.log('  model           :', status.data.model);
  console.log('  endpointDerived :', status.data.endpointDerived);
  console.log('  endpoint        :', status.data.endpoint);
  console.log('  key leaked?     :', secrets.every(value => !JSON.stringify(status.data).includes(value)) ? 'no' : 'YES');

  console.log('\n=== /api/chat  (a real round trip to the provider) ===');
  const chat = await call('/chat', { method: 'POST', body: { message: 'In one short sentence, what is REVEX?' } });
  console.log('  status          :', chat.status);
  if (chat.status === 200) {
    console.log('  reply           :', String(chat.data.reply).replace(/\s+/g, ' ').slice(0, 160));
    console.log('  conversationId  :', chat.data.conversation?.id || '(none)');
    console.log('  messages stored :', chat.data.conversation?.messages?.length);
  } else {
    console.log('  error           :', chat.data.message);
  }

  console.log('\n=== /api/chat/conversations ===');
  const list = await call('/chat/conversations');
  console.log('  status          :', list.status, '| conversations:', Array.isArray(list.data) ? list.data.length : list.data);

  console.log('\n=== security: an unauthenticated chat request ===');
  const anon = await call('/chat', { method: 'POST', auth: false, body: { message: 'hi' } });
  console.log('  status          :', anon.status, anon.status === 401 ? '(correctly rejected)' : '(UNEXPECTED)');
})().catch(error => { console.error('probe failed:', error.message); process.exit(1); });

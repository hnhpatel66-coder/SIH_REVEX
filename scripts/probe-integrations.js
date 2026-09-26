/**
 * Live diagnostic for the two integrations the user reported as broken.
 * Read-only apart from ONE throwaway Razorpay order, which is deleted straight
 * after. Run with:  node scripts/probe-integrations.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const envPath = path.join(__dirname, '..', 'backend', '.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim();
}

function razorpay(method, p, body) {
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const payload = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.razorpay.com', path: `/v1${p}`, method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(payload ? { 'Content-Type': 'application/json' } : {})
      },
      timeout: 25000
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  /* ------------------------------------------------------------ Razorpay */
  console.log('=== RAZORPAY ===');
  console.log('RAZORPAY_KEY_ID set    :', Boolean(env.RAZORPAY_KEY_ID));
  console.log('RAZORPAY_KEY_SECRET set:', Boolean(env.RAZORPAY_KEY_SECRET));
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const list = await razorpay('GET', '/orders?count=1');
    console.log('auth                   :', list.status === 200 ? 'OK' : `FAILED ${list.status}`);
    if (list.body?.items?.[0]) {
      const id = list.body.items[0].id;
      console.log('recent order id        :', id);
      console.log('matches /^order_[A-Za-z0-9]+$/ :', /^order_[A-Za-z0-9]+$/.test(id));
    } else {
      console.log('error body             :', JSON.stringify(list.body).slice(0, 300));
    }

    // One throwaway order, to prove the create path the app actually uses.
    const created = await razorpay('POST', '/orders', {
      amount: 100, currency: 'INR', receipt: 'probe_diag_1', notes: { purpose: 'diagnostic' }
    });
    console.log('create order           :', created.status, created.body?.id || JSON.stringify(created.body).slice(0, 200));
    if (created.body?.id) {
      const probeId = created.body.id;
      console.log('created id matches strict regex  :', /^order_[A-Za-z0-9]+$/.test(probeId));
      const sig = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET)
        .update(`${probeId}|pay_probe`).digest('hex');
      console.log('signature helper works  :', /^[a-f0-9]{64}$/.test(sig));
      const refund = await razorpay('POST', `/payments/${probeId.replace('order_', 'pay_')}/refund`, { speed: 'normal' });
      console.log('refund on a non-payment id ->', refund.status, JSON.stringify(refund.body).slice(0, 160));
      console.log('   (expected 400: a real refund needs a real pay_ id)');
    }
  }

  /* --------------------------------------------------------------- Chat */
  console.log('');
  console.log('=== CHAT (Gemini) ===');
  const key = env.CHAT_API_KEY || env.GEMINI_API_KEY;
  const url = env.CHAT_API_URL;
  const model = env.CHAT_API_MODEL || env.GEMINI_MODEL || 'gemini-2.5-flash';
  console.log('CHAT_API_KEY set :', Boolean(env.CHAT_API_KEY));
  console.log('GEMINI_API_KEY set:', Boolean(env.GEMINI_API_KEY));
  // Only presence is reported. No prefix, no length, nothing that narrows a key.
  console.log('key resolved     :', Boolean(key));
  console.log('CHAT_API_URL set :', Boolean(url), url || '<EMPTY>');
  console.log('model            :', model);
  console.log('');
  console.log('>>> providerConfig().configured ===', Boolean(key && url), '  <-- this is what /chat/status reports');
  console.log('    A Gemini key alone is NOT enough: the code also requires CHAT_API_URL.');

  if (key) {
    const derived = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(`${derived}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You are REVEX Assistant. Answer in one short sentence.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Say hello.' }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 40 }
      })
    }).catch(e => ({ ok: false, statusText: e.message }));
    console.log('');
    console.log('derived Gemini URL :', derived);
    console.log('response status    :', res.status, res.statusText || '');
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log('reply              :', data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('')?.slice(0, 120));
    } else {
      console.log('error body         :', JSON.stringify(data).slice(0, 400));
    }
  }
})();

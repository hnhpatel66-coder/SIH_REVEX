// Removes leftover QA/automated-test records. Safe by default: it only touches
// records whose name/email matches an explicit QA pattern.
//
// Usage:  node scripts/cleanup-qa.js            (dry run, lists what it would remove)
//         node scripts/cleanup-qa.js --apply    (permanent delete / deactivate)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

const BASE = process.env.REVEX_BASE || require('./base-url').url;
const APPLY = process.argv.includes('--apply');

// Deliberately narrow: only names/emails created by the automated suites.
const QA_NAME = /^(Filter Test|QA |Other Owner Car|Reject Target|UI\d|Maruti Swift VXi|Onboarder)/i;
const QA_EMAIL = /^(qa\.|rp\.|rl\.|probe\.)/i;

async function call(p, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

(async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  if (login.status !== 200) { console.error('Admin login failed. Check backend/.env'); process.exit(1); }
  const token = login.data.token;

  const vehiclesRes = await call('/api/admin/vehicles?status=all', { token });
  const vehicles = (vehiclesRes.data.vehicles || vehiclesRes.data || [])
    .filter(v => QA_NAME.test(v.name || '') && v.status !== 'removed');

  const usersRes = await call('/api/admin/users', { token });
  const users = (usersRes.data.users || usersRes.data || [])
    .filter(u => QA_EMAIL.test(u.email || ''));

  console.log(`${APPLY ? 'Applying' : 'Dry run — would remove'}: ${vehicles.length} test vehicle(s), ${users.length} test account(s)\n`);

  if (APPLY) {
    for (const v of vehicles) {
      const r = await call(`/api/admin/vehicles/${v.id}`, { method: 'DELETE', token, body: { reason: 'QA cleanup', confirm: true } });
      console.log(`  vehicle "${v.name}" [${v.status}] -> ${r.status}`);
    }
    for (const u of users) {
      if (u.role === 'admin') { console.log(`  SKIPPED admin account ${u.email}`); continue; }
      const r = await call(`/api/admin/users/${u.id || u._id}`, { method: 'DELETE', token });
      console.log(`  user "${u.email}" -> ${r.status}`);
    }
  } else {
    vehicles.forEach(v => console.log(`  would permanently delete vehicle "${v.name}" [${v.status}]`));
    users.forEach(u => console.log(`  would deactivate user ${u.email} (${u.role})`));
    console.log('\nRe-run with --apply to execute.');
  }
})().catch(error => { console.error('Cleanup failed:', error.message); process.exit(1); });

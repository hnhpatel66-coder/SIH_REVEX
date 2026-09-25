// Lists accounts carrying the legacy deactivatedAt marker (pre hard-delete).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { buildMongoUri } = require('../backend/utils/db');
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(buildMongoUri(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'vroomy'), { serverSelectionTimeoutMS: 12000, family: 4 });
  const users = await mongoose.connection.db.collection('users')
    .find({ deactivatedAt: { $exists: true } })
    .project({ name: 1, email: 1, role: 1, isActive: 1 })
    .toArray();

  const groups = {};
  for (const u of users) {
    const email = String(u.email || '');
    const domain = email.split('@')[1] || 'none';
    const isQa = /^(qa|rp|rl|probe|test|filter|ui\.|themeprobe|profprobe|browser|formtest|captured|sameorigin|scenario|scen)/i.test(email.split('@')[0]);
    const key = isQa ? 'automated-test accounts' : `real-looking (${domain})`;
    groups[key] = (groups[key] || 0) + 1;
  }
  console.log('\nAccounts with legacy deactivatedAt marker:');
  Object.entries(groups).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));

  const nonQa = users.filter(u => !/^(qa|rp|rl|probe|test|filter|ui\.|themeprobe|profprobe|browser|formtest|captured|sameorigin|scenario|scen)/i.test(String(u.email || '').split('@')[0]));
  if (nonQa.length) {
    console.log('\nNon-test accounts that would be affected:');
    nonQa.slice(0, 25).forEach(u => console.log(`  ${u.email}  (${u.role}, isActive=${u.isActive})`));
  }
  await mongoose.disconnect();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });

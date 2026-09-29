const path = require('path');
const { spawnSync } = require('child_process');

const required = ['dotenv', 'express', 'mongoose', 'bcryptjs', 'jsonwebtoken', 'nodemailer'];
const missing = required.filter(name => {
  try { require.resolve(name, { paths: [__dirname] }); return false; }
  catch (_) { return true; }
});

if (missing.length) {
  console.log('[REVEX] Missing backend dependencies:', missing.join(', '));
  console.log('[REVEX] Installing backend dependencies automatically...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: __dirname, stdio: 'inherit', shell: false
  });
  if (result.status !== 0) {
    console.error('[REVEX] Dependency installation failed. Run: npm install');
    process.exit(result.status || 1);
  }
}

require(path.join(__dirname, 'server.js'));

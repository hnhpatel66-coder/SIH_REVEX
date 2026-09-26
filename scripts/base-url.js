/**
 * Resolves the API base URL for the test suites from backend/.env so tests
 * follow the configured PORT instead of a hard-coded value.
 * Usage in a test:  const BASE = require('../scripts/base-url');
 */
const fs = require('fs');
const path = require('path');

function readEnv() {
  try {
    return Object.fromEntries(
      fs.readFileSync(path.join(__dirname, '..', 'backend', '.env'), 'utf8')
        .split(/\r?\n/)
        .filter(line => /^[A-Z_]+=/.test(line))
        .map(line => {
          const i = line.indexOf('=');
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

const env = readEnv();
const PORT = Number(process.env.REVEX_PORT || env.PORT || 5001);
const url = `http://localhost:${PORT}`;

module.exports = {
  url,
  PORT,
  env,
  // Convenience: template literals and String() both yield the URL.
  toString: () => url
};

#!/usr/bin/env node
/**
 * RUN EVERY OFFLINE TEST SUITE  (tests/run-all.js)
 *
 * `npm test`
 *
 * These suites need no database, no network and no running server, so they can
 * be run on a fresh clone immediately after `npm install`. The end-to-end API
 * suite is separate (`npm run test:api`) because it does need a live server.
 *
 * Any failure prints the file that failed and exits non-zero.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;

/**
 * The offline suites, in dependency order: cheap unit checks first, then the
 * static contract checks that read the whole source tree.
 */
const SUITES = [
  'pricing.test.js',
  'ride-pricing.test.js',
  'cancellation-policy.test.js',
  'statuses.test.js',
  'validation.test.js',
  'frontend-contract.test.js',
  'cross-file-helpers.test.js',
  'no-duplicate-routes.test.js',
  'responsive-a11y.test.js',
  'security.test.js',
  'registration-regression.test.js',
  'theme.test.js',
  'cors.test.js',
  'deployment.test.js',
  'rental-quote.test.js',
  'integrations.test.js'
];

/** Suites that need a live server or a database; listed, never run, by default. */
const MANUAL = [
  ['api-flow.test.js', 'needs a running server: TEST_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD'],
  ['e2e.test.js', 'needs a running server and seeded data'],
  ['cluster.test.js', 'needs a running MongoDB replica set'],
  ['hard-delete.test.js', 'needs a disposable database'],
  ['availability.test.js', 'needs a disposable database'],
  ['filters.test.js', 'needs a running server']
];

function main() {
  let total = 0;
  const failures = [];

  for (const suite of SUITES) {
    const file = path.join(DIR, suite);
    if (!fs.existsSync(file)) { failures.push({ suite, reason: 'file not found' }); continue; }
    process.stdout.write(`\n── ${suite}\n`);
    try {
      execFileSync(process.execPath, [file], { stdio: 'inherit' });
      total += 1;
    } catch (error) {
      failures.push({ suite, reason: (error.stderr && String(error.stderr).split('\n').slice(0, 4).join('\n')) || error.message });
    }
  }

  // The maintenance scripts must be idempotent, or every "npm run sync" would
  // produce a diff for the next person.
  for (const script of ['sync-ui-layer.js', 'sync-page-meta.js', 'sync-button-types.js', 'sync-field-labels.js', 'sync-ui-tokens.js']) {
    process.stdout.write(`\n── ${script} --check\n`);
    try {
      execFileSync(process.execPath, [path.join(DIR, '..', 'scripts', script), '--check'], { stdio: 'inherit' });
      total += 1;
    } catch (error) {
      failures.push({ suite: script, reason: (error.stderr && String(error.stderr).split('\n').slice(0, 4).join('\n')) || error.message });
    }
  }

  process.stdout.write('\n── check-syntax.js\n');
  try {
    execFileSync(process.execPath, [path.join(DIR, '..', 'scripts', 'check-syntax.js')], { stdio: 'inherit' });
    total += 1;
  } catch (error) {
    failures.push({ suite: 'check-syntax.js', reason: error.message });
  }

  console.log('\n──────────────────────────────────────────────');
  if (failures.length) {
    console.error(`FAILED: ${failures.length} of ${SUITES.length + 5} check(s)\n`);
    for (const failure of failures) console.error(`  ${failure.suite}\n    ${failure.reason}\n`);
    process.exit(1);
  }
  console.log(`All ${total} offline check group(s) passed.`);
  console.log('\nNot run (they need a server or a database):');
  for (const [suite, why] of MANUAL) console.log(`  ${suite.padEnd(24)} ${why}`);
  console.log('\nRun the end-to-end API suite with:  npm run test:api');
}

main();

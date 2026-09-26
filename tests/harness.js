/**
 * Shared test harness.
 *
 * Every test file in tests/ is a plain Node script that throws on the first
 * failed assertion, so a failure is a non-zero exit code. These helpers keep
 * the output readable and the counting consistent, and they let a test file
 * report the section it is in when something goes wrong.
 */
'use strict';

const assert = require('node:assert/strict');

function createSuite(name) {
  let checks = 0;
  let section = '';

  const api = {
    /** Runs a named group of checks. */
    describe(title, body) {
      section = title;
      body();
      section = '';
    },
    /**
     * The same, for a group whose body is async.
     *
     * Added for tests/rental-quote.test.js, which drives a real form and has to
     * await the page's own event handlers. A failure inside still throws, so the
     * file exits non-zero.
     */
    async describeAsync(title, body) {
      section = title;
      try {
        await body();
      } finally {
        section = '';
      }
    },
    /** One named async case, awaited in order. */
    async test(title, body) {
      const previous = section;
      section = previous ? `${previous} > ${title}` : title;
      try {
        await body();
      } finally {
        section = previous;
      }
    },
    ok(condition, message) {
      checks += 1;
      assert.ok(condition, `${section ? `[${section}] ` : ''}${message}`);
    },
    equal(actual, expected, message) {
      checks += 1;
      assert.equal(actual, expected, `${section ? `[${section}] ` : ''}${message}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
    },
    deepEqual(actual, expected, message) {
      checks += 1;
      assert.deepEqual(actual, expected, `${section ? `[${section}] ` : ''}${message}`);
    },
    match(value, pattern, message) {
      checks += 1;
      assert.match(String(value), pattern, `${section ? `[${section}] ` : ''}${message}`);
    },
    notMatch(value, pattern, message) {
      checks += 1;
      assert.doesNotMatch(String(value), pattern, `${section ? `[${section}] ` : ''}${message}`);
    },
    throws(body, message) {
      checks += 1;
      assert.throws(body, undefined, `${section ? `[${section}] ` : ''}${message}`);
    },
    get count() { return checks; },
    done() {
      console.log(`PASS  ${name}  (${checks} checks)`);
    }
  };
  return api;
}

module.exports = { createSuite, assert };

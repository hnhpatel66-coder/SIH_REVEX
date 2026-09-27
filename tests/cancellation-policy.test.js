#!/usr/bin/env node
/**
 * CENTRALISED CANCELLATION POLICY  (tests/cancellation-policy.test.js)
 *
 * The spec for 1.3 is that cancellation has ONE configurable policy with no
 * hard-coded percentages, that the fee and the refund always add back up to the
 * amount paid, and that "no money disappears" - whatever is not refunded is
 * always described as a fee, compensation or commission.
 *
 * These tests pin all three.
 */
'use strict';

const { createSuite } = require('./harness');
const { computeCancellation, refundPlan, loadPolicy, DEFAULT_POLICY } = require('../backend/utils/cancellation');

const t = createSuite('cancellation policy');
const saved = { ...process.env };

function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

const HOUR = 3600000;
const START = new Date(Date.now() + 24 * HOUR);

t.describe('policy is read from the environment', () => {
  setEnv({ CANCEL_FREE_WINDOW_HOURS: '8', CANCEL_FEE_PERCENT_USER: '15', CANCEL_FEE_MAX_USER: '900' });
  const policy = loadPolicy();
  t.equal(policy.freeWindowHours, 8, 'the free window comes from the environment');
  t.equal(policy.feePercent.user, 15, 'the user percentage comes from the environment');
  t.equal(policy.feeMax.user, 900, 'the user ceiling comes from the environment');

  setEnv({ CANCEL_FREE_WINDOW_HOURS: 'not-a-number' });
  t.equal(loadPolicy().freeWindowHours, DEFAULT_POLICY.freeWindowHours, 'a non-numeric window falls back to the default');
  setEnv({ CANCEL_FREE_WINDOW_HOURS: '-5' });
  t.equal(loadPolicy().freeWindowHours, 0, 'a negative window is clamped to zero');

  setEnv({ CANCEL_FEE_PERCENT_USER: '500' });
  t.equal(loadPolicy().feePercent.user, 100, 'a percentage above 100 is clamped to 100');
  setEnv({ CANCEL_FEE_PERCENT_USER: '-20' });
  t.equal(loadPolicy().feePercent.user, 0, 'a negative percentage is clamped to zero');
  setEnv({ CANCEL_FEE_PERCENT_USER: undefined });
});

t.describe('the free cancellation window', () => {
  setEnv({ CANCEL_FREE_WINDOW_HOURS: '6', CANCEL_FEE_PERCENT_USER: '10', CANCEL_FEE_MAX_USER: '0', CANCEL_FEE_FLAT_USER: '0' });

  const early = computeCancellation({ amount: 1000, actor: 'user', startsAt: START });
  t.equal(early.withinFreeWindow, true, 'cancelling 24 hours before a 6-hour window is free');
  t.equal(early.cancellationFee, 0, 'a free cancellation charges nothing');
  t.equal(early.refundAmount, 1000, 'a free cancellation refunds everything');
  t.match(early.explanation, /no cancellation fee/i, 'the explanation says why there is no fee');

  const late = computeCancellation({ amount: 1000, actor: 'user', startsAt: new Date(Date.now() + 2 * HOUR) });
  t.equal(late.withinFreeWindow, false, 'cancelling two hours before is outside the window');
  t.equal(late.cancellationFee, 100, '10% of 1000 is retained');
  t.equal(late.refundAmount, 900, 'the balance is refunded');

  // A window of 0 means "no free window", NOT "always free".
  setEnv({ CANCEL_FREE_WINDOW_HOURS: '0' });
  const noWindow = computeCancellation({ amount: 1000, actor: 'user', startsAt: new Date(Date.now() + 500 * HOUR) });
  t.equal(noWindow.withinFreeWindow, false, 'a zero window disables the free cancellation entirely');
  t.equal(noWindow.cancellationFee, 100, 'the fee still applies when the window is disabled');
  setEnv({ CANCEL_FREE_WINDOW_HOURS: '6' });
});

t.describe('money always adds up', () => {
  setEnv({ CANCEL_FREE_WINDOW_HOURS: '0', CANCEL_FEE_PERCENT_USER: '10', CANCEL_FEE_FLAT_USER: '0', CANCEL_FEE_MAX_USER: '0' });
  for (const amount of [0, 1, 49.99, 500, 12345.67]) {
    const result = computeCancellation({ amount, actor: 'user', flow: 'ride' });
    t.equal(
      Number((result.cancellationFee + result.refundAmount).toFixed(2)),
      Number(result.originalAmount.toFixed(2)),
      `fee + refund equals the amount paid for ₹${amount}`
    );
    t.ok(result.refundAmount >= 0, 'a refund is never negative');
    t.ok(result.cancellationFee <= result.originalAmount, 'the fee never exceeds the amount paid');
  }
});

t.describe('percentage, flat fee and ceiling compose', () => {
  setEnv({ CANCEL_FREE_WINDOW_HOURS: '0', CANCEL_FEE_PERCENT_USER: '10', CANCEL_FEE_FLAT_USER: '50', CANCEL_FEE_MAX_USER: '120' });
  const capped = computeCancellation({ amount: 1000, actor: 'user' });
  t.equal(capped.cancellationFee, 120, '10% plus a flat 50 is 150, clamped to the 120 ceiling');

  setEnv({ CANCEL_FEE_MAX_USER: '0' });
  const uncapped = computeCancellation({ amount: 1000, actor: 'user' });
  t.equal(uncapped.cancellationFee, 150, 'a ceiling of zero means no ceiling at all');
  setEnv({ CANCEL_FEE_FLAT_USER: '0', CANCEL_FEE_MAX_USER: '1500' });
});

t.describe('per-actor fees', () => {
  setEnv({
    CANCEL_FREE_WINDOW_HOURS: '0',
    CANCEL_FEE_PERCENT_USER: '10', CANCEL_FEE_PERCENT_OWNER: '25', CANCEL_FEE_PERCENT_ADMIN: '0',
    CANCEL_FEE_FLAT_USER: '0', CANCEL_FEE_FLAT_OWNER: '0', CANCEL_FEE_FLAT_ADMIN: '0',
    CANCEL_FEE_MAX_USER: '1500', CANCEL_FEE_MAX_OWNER: '2500', CANCEL_FEE_MAX_ADMIN: '0',
    CANCEL_OWNER_PENALTY_MULTIPLIER: '1'
  });
  t.equal(computeCancellation({ amount: 1000, actor: 'user' }).cancellationFee, 100, 'the rider fee applies to a rider cancellation');
  t.equal(computeCancellation({ amount: 1000, actor: 'owner' }).cancellationFee, 250, 'the owner fee applies to an owner cancellation');
  t.equal(computeCancellation({ amount: 1000, actor: 'admin' }).cancellationFee, 0, 'an admin cancellation is free by default');
  t.equal(computeCancellation({ amount: 1000, actor: 'nobody' }).cancelledBy, 'user', 'an unknown actor is treated as a rider, never as a privileged one');

  setEnv({ CANCEL_OWNER_PENALTY_MULTIPLIER: '2' });
  t.equal(computeCancellation({ amount: 1000, actor: 'owner' }).cancellationFee, 500, 'the owner multiplier doubles the fee');
  setEnv({ CANCEL_OWNER_PENALTY_MULTIPLIER: '1' });
});

t.describe('unpaid bookings', () => {
  setEnv({ CANCEL_FREE_WINDOW_HOURS: '0', CANCEL_FEE_PERCENT_USER: '10', CANCEL_FEE_MAX_USER: '1500' });
  const unpaid = computeCancellation({ amount: 0, actor: 'user' });
  t.equal(unpaid.cancellationFee, 0, 'no payment means no fee');
  t.equal(unpaid.refundAmount, 0, 'no payment means no refund');
  t.match(unpaid.explanation, /nothing to refund/i, 'the explanation says there was nothing to refund');
});

t.describe('a missing start date', () => {
  setEnv({ CANCEL_FREE_WINDOW_HOURS: '6' });
  const noStart = computeCancellation({ amount: 500, actor: 'user' });
  t.equal(noStart.withinFreeWindow, false, 'without a start time there is no free window to be inside');
  t.equal(noStart.hoursToStart, null, 'the hours-to-start is reported as unknown, not as zero');
  t.equal(noStart.cancellationFee, 50, 'the policy fee still applies');
});

t.describe('refund plans', () => {
  const razorpay = refundPlan({ amount: 1000, fee: 100, method: 'razorpay' });
  t.equal(razorpay.refundAmount, 900, 'the plan refunds the amount less the fee');
  t.equal(razorpay.channel, 'razorpay', 'a real gateway is named as the channel');
  t.equal(razorpay.refundable, true, 'a positive refund is refundable');

  const manual = refundPlan({ amount: 1000, fee: 0, method: 'demo' });
  t.equal(manual.channel, 'manual', 'a payment without a gateway is marked for manual processing');
  t.match(manual.note, /manual/i, 'the note explains the manual step');

  const nothing = refundPlan({ amount: 1000, fee: 1000, method: 'razorpay' });
  t.equal(nothing.refundable, false, 'a fully retained amount is not refundable');

  const unpaid = refundPlan({ amount: 0, fee: 0, method: 'razorpay' });
  t.equal(unpaid.refundable, false, 'an unpaid record has nothing to refund');
});

t.describe('records are auditable', () => {
  setEnv({ CANCEL_FREE_WINDOW_HOURS: '0', CANCEL_FEE_PERCENT_USER: '10' });
  const result = computeCancellation({ amount: 800, actor: 'user', reason: 'Change of plan', flow: 'ride', startsAt: START });
  t.equal(result.flow, 'ride', 'the flow is recorded so rental and ride records never mix');
  t.equal(result.reason, 'Change of plan', 'the reason is preserved verbatim');
  t.equal(result.policyVersion, 'revex-cancellation-v1', 'the policy version is recorded for later audit');
  t.equal(result.freeWindowHours, 0, 'the window in force is recorded with the result');
});

Object.keys(saved).forEach(key => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
t.done();

#!/usr/bin/env node
/**
 * RIDE PRICING  (tests/ride-pricing.test.js)
 *
 * The single most important invariant in the 1.3 ride flow: ONE definition of
 * what a rider pays. Find Ride, the booking panel, the Razorpay order and the
 * stored booking must all show the same number, and the browser must never be
 * able to influence it.
 */
'use strict';

const { createSuite } = require('./harness');
const { calculateRideQuote, availableSeats, ownerShare, MAX_SEATS, OWNER_SHARE_RATE } = require('../backend/utils/ridePricing');

const t = createSuite('ride pricing');
const env = { ...process.env };

function withFee(percent, body) {
  process.env.PLATFORM_FEE_PERCENT = String(percent);
  return body();
}

t.describe('base fare and platform fee', () => {
  t.equal(calculateRideQuote({ price: 200 }, 1).baseRideAmount, 200, 'one seat at 200 is 200');
  t.equal(calculateRideQuote({ price: 200 }, 3).baseRideAmount, 600, 'three seats at 200 is 600');
  t.equal(calculateRideQuote({ price: 200 }, 3).seats, 3, 'the seat count is echoed back');

  withFee(10, () => {
    const quote = calculateRideQuote({ price: 200 }, 1);
    t.equal(quote.platformFee, 20, 'a 10% platform fee on 200 is 20');
    t.equal(quote.grandTotal, 220, 'the total is the fare plus the fee');
    t.equal(quote.payableAmount, quote.grandTotal, 'payableAmount and grandTotal never disagree');
  });

  withFee(0, () => {
    t.equal(calculateRideQuote({ price: 500 }, 2).grandTotal, 1000, 'a zero platform fee means the total is the bare fare');
  });

  withFee(10, () => {
    t.equal(calculateRideQuote({ price: 199.99 }, 1).grandTotal, 219.99, 'money is rounded to paise, not truncated');
  });
});

t.describe('extras and discounts', () => {
  withFee(10, () => {
    const quote = calculateRideQuote({ price: 100, additionalCharges: 50 }, 2);
    t.equal(quote.subtotal, 250, 'extras are added to the fare before the fee');
    t.equal(quote.platformFee, 25, 'the fee is charged on the subtotal including extras');
    t.equal(quote.grandTotal, 275, 'total = fare + extras + fee');

    const discounted = calculateRideQuote({ price: 100, discountPercent: 50 }, 1);
    t.equal(discounted.discountAmount, 55, 'the discount is 50% of 110 (fare + fee)');
    t.equal(discounted.grandTotal, 55, 'the discount comes off last');
  });
});

t.describe('the backend is the authority', () => {
  withFee(10, () => {
    const stored = { price: 300, additionalCharges: 0, discountPercent: 0 };
    // Whatever the browser claims, the quote is recomputed from the ride.
    const fromServer = calculateRideQuote(stored, 2);
    t.equal(fromServer.grandTotal, 660, '2 seats at 300 plus 10% is 660 regardless of any client input');
    t.equal(calculateRideQuote({ price: 300, additionalCharges: 99999 }, 1).grandTotal > 0, true, 'a pathological extra cannot produce a negative total');
    t.equal(calculateRideQuote({ price: -50 }, 1).grandTotal >= 0, true, 'a negative stored price never produces a negative charge');
  });
});

t.describe('seat clamping', () => {
  withFee(10, () => {
    t.equal(calculateRideQuote({ price: 100 }, 0).seats, 1, 'zero seats is clamped to one');
    t.equal(calculateRideQuote({ price: 100 }, 99).seats, MAX_SEATS, 'a seat count above the maximum is clamped');
    t.equal(calculateRideQuote({ price: 100 }, -3).seats, 1, 'a negative seat count is clamped to one');
    t.equal(calculateRideQuote({ price: 100 }, 2.7).seats, 2, 'a fractional seat count is truncated');
  });
});

t.describe('availability', () => {
  t.equal(availableSeats({ totalSeats: 5, bookedSeats: 0 }), 5, 'an untouched ride has every seat free');
  t.equal(availableSeats({ totalSeats: 5, bookedSeats: 2 }), 3, 'booked seats are subtracted');
  t.equal(availableSeats({ totalSeats: 5, bookedSeats: 5 }), 0, 'a full ride has none left');
  t.equal(availableSeats({ totalSeats: 5, bookedSeats: 9 }), 0, 'over-booked history never reports a negative number');
  t.equal(availableSeats({ totalSeats: 0, bookedSeats: 0 }), 0, 'a ride with no seats has none');
});

t.describe('revenue split', () => {
  t.equal(OWNER_SHARE_RATE, 0.9, 'the owner share is 90%');
  t.equal(ownerShare(1000), 900, 'the owner receives 90% of 1000');
  t.equal(ownerShare(0), 0, 'a zero revenue splits to zero');
  withFee(10, () => {
    const quote = calculateRideQuote({ price: 1000 }, 1);
    t.equal(quote.grandTotal, 1100, 'the total includes the platform fee');
    t.equal(quote.ownerShare + quote.platformEarnings, quote.grandTotal, 'the split adds back up to the total exactly');
  });
});

t.describe('quote shape', () => {
  withFee(10, () => {
    const quote = calculateRideQuote({ price: 120, additionalCharges: 20, discountPercent: 5 }, 2);
    t.equal(quote.currency, 'INR', 'the quote names its currency');
    t.match(quote.formula, /seat/, 'the formula describes the calculation in words');
    t.equal(quote.pricingVersion, 'revex-ride-pricing-v1', 'the quote is versioned so the UI can adapt');
    t.equal(quote.platformFeePercent, 10, 'the fee percentage is reported, not just the amount');
  });
});

Object.keys(env).forEach(key => { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; });
t.done();

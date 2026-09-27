#!/usr/bin/env node
/**
 * PAGE META SYNC  (scripts/sync-page-meta.js)
 *
 * Every page needs a `<title>` and a `<meta name="description">`. They were
 * added by hand one at a time, which is how half the pages ended up with a
 * generic description and several with none at all.
 *
 * This script holds the canonical copy for each page and writes it in, so the
 * titles and descriptions are consistent, describe what the page actually does
 * in 1.3, and stay in step with each other.
 *
 * Usage:
 *   node scripts/sync-page-meta.js           # write
 *   node scripts/sync-page-meta.js --check   # fail if any page is stale
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');
const BRAND = 'REVEX';

/** file -> { title, description }. Anything not listed here is left alone. */
const META = {
  'index.html': {
    title: `Home | ${BRAND}`,
    description: `${BRAND} moves you smarter: rent a verified vehicle or share a ride with a local driver. One account for riding, lending and earning.`
  },
  'login.html': {
    title: `Log in | ${BRAND}`,
    description: `Log in to your ${BRAND} account to book rides, rent vehicles, review owner requests and track your earnings.`
  },
  'register.html': {
    title: `Create an account | ${BRAND}`,
    description: `Create a free ${BRAND} account as a rider or as a vehicle owner. Verification is instant; vehicle and ride approvals are done by an admin.`
  },
  'forgot-password.html': {
    title: `Reset your password | ${BRAND}`,
    description: `Request a password reset link for your ${BRAND} account.`
  },
  'reset-password.html': {
    title: `Choose a new password | ${BRAND}`,
    description: `Set a new password for your ${BRAND} account using the reset link from your email.`
  },
  'rental.html': {
    title: `Rent a Vehicle | ${BRAND}`,
    description: `Browse admin-approved ${BRAND} vehicles with real photos and transparent hourly pricing, then book with an online payment and a digital rental agreement.`
  },
  'vehicle-details.html': {
    title: `Vehicle details | ${BRAND}`,
    description: `Full ${BRAND} vehicle details: photos, documents, specifications, live availability and a transparent price breakdown before you book.`
  },
  'find-ride.html': {
    title: `Find a Ride | ${BRAND}`,
    description: `Browse approved ${BRAND} ride offers. Compare vehicle photos, driver details, route, timing, available seats and the full total, then pay and book a seat instantly.`
  },
  'ride-details.html': {
    title: `Ride Details | ${BRAND}`,
    description: `See the full details of a ${BRAND} ride offer, choose your seats, and Pay & Book Ride with a total calculated by the server.`
  },
  'offer-ride.html': {
    title: `Offer a Ride | ${BRAND}`,
    description: `Publish a ${BRAND} ride offer. Pick one of your registered vehicles to reuse its photo, set the route, date, seats and price per seat, and an admin approves it before it goes live.`
  },
  'ride-requests.html': {
    title: `Ride Booking Requests | ${BRAND}`,
    description: `Paid seat requests on the ${BRAND} ride offers you published. Approve or decline each rider; declining refunds them under the cancellation policy.`
  },
  'bookings.html': {
    title: `My Bookings | ${BRAND}`,
    description: `Every ${BRAND} rental booking and shared-ride seat in one list, with the exact total, the payment status, the vehicle photo, and a cancellation quote taken from the server policy.`
  },
  'agreement.html': {
    title: `Rental Agreement | ${BRAND}`,
    description: `View, sign and download the ${BRAND} rental agreement for your booking, including the pricing snapshot and the full terms.`
  },
  'list-vehicle.html': {
    title: `Owner Dashboard | ${BRAND}`,
    description: `${BRAND} owner control centre: list a vehicle, review rental booking requests and paid ride seat requests, and track transparent vehicle-wise earnings.`
  },
  'admin.html': {
    title: `Admin Control Centre | ${BRAND}`,
    description: `${BRAND} admin control centre: platform overview, owner summary dashboard, vehicle moderation, ride approvals, rental and ride bookings, payments, reports and the assistant.`
  },
  'admin-setup.html': {
    title: `Admin setup | ${BRAND}`,
    description: `One-time ${BRAND} administrator setup. Requires the ADMIN_SETUP_KEY from the server environment.`
  },
  'profile.html': {
    title: `Profile | ${BRAND}`,
    description: `Manage your ${BRAND} account: name, phone, profile photo, owner registration, notifications and saved rental agreements.`
  },
  'chat.html': {
    title: `Assistant | ${BRAND}`,
    description: `Ask the ${BRAND} Assistant about finding a ride, renting a vehicle, payments, cancellations and refunds. Your conversation is stored against your own account.`
  }
};

function apply(html, meta) {
  let next = html;
  const title = `<title>${meta.title}</title>`;
  next = /<title>[\s\S]*?<\/title>/i.test(next)
    ? next.replace(/<title>[\s\S]*?<\/title>/i, title)
    : next.replace('</head>', `  ${title}\n</head>`);

  const description = `  <meta name="description" content="${meta.description}">`;
  next = /<meta\s+name="description"[^>]*>/i.test(next)
    ? next.replace(/[ \t]*<meta\s+name="description"[^>]*>/i, description)
    : next.replace('</head>', `${description}\n</head>`);
  return next;
}

const problems = [];
let changed = 0;
const files = Object.keys(META);

for (const name of files) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) { problems.push(`${name}: missing`); continue; }
  const original = fs.readFileSync(file, 'utf8');
  const next = apply(original, META[name]);
  if (next === original) continue;
  if (CHECK_ONLY) problems.push(`${name}: title or description is stale`);
  else { fs.writeFileSync(file, next); changed += 1; console.log(`updated ${name}`); }
}

if (CHECK_ONLY) {
  if (problems.length) {
    console.error('Page meta is not in sync:');
    problems.forEach(problem => console.error(`  - ${problem}`));
    console.error('\nRun:  node scripts/sync-page-meta.js');
    process.exit(1);
  }
  console.log(`Page meta is in sync across ${files.length} page(s).`);
} else {
  console.log(changed ? `Updated ${changed} of ${files.length} page(s).` : `All ${files.length} page(s) already in sync.`);
}

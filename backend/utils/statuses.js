/**
 * Centralised status vocabulary.
 *
 * Before this module every route invented its own status strings, which is how
 * `paid`, `confirmed`, `cancelled_by_user` and `refunded` ended up meaning
 * slightly different things in the rental and the ride flow. Routes now import
 * these maps so the API, the database and the UI always agree.
 *
 * IMPORTANT: the stored values are the source of truth and are kept
 * backward compatible with every record already in MongoDB. Nothing here
 * renames a persisted value.
 */

/* ------------------------------------------------------------------ rides */
const RIDE_STATUS = {
  PENDING: 'pending',      // owner submitted, waiting for admin approval
  APPROVED: 'approved',    // admin approved -> visible in Find Ride
  REJECTED: 'rejected',    // admin rejected -> never listed
  REMOVED: 'removed',      // admin removed a previously approved offer
  CANCELLED: 'cancelled',  // cancelled by the owner
  ACTIVE: 'active',        // approved and the departure window is open
  COMPLETED: 'completed'   // departure happened, ride is finished
};

// `available` was the pre-1.0 name for an approved ride. It is still accepted
// on read and normalised to `approved` so existing rows keep working.
const RIDE_STATUS_ALIASES = { available: RIDE_STATUS.APPROVED, pending_approval: RIDE_STATUS.PENDING };

const RIDE_STATUS_LABELS = {
  [RIDE_STATUS.PENDING]: 'Pending approval',
  [RIDE_STATUS.APPROVED]: 'Available',
  [RIDE_STATUS.REJECTED]: 'Rejected',
  [RIDE_STATUS.REMOVED]: 'Removed',
  [RIDE_STATUS.CANCELLED]: 'Cancelled',
  [RIDE_STATUS.ACTIVE]: 'In progress',
  [RIDE_STATUS.COMPLETED]: 'Completed'
};

/** Statuses that may appear on the public Find Ride portal. */
const PUBLIC_RIDE_STATUSES = [RIDE_STATUS.APPROVED, 'available'];

/* ------------------------------------------------------- vehicle listings */
const VEHICLE_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  REMOVED: 'removed'
};

const VEHICLE_STATUS_ALIASES = { available: VEHICLE_STATUS.APPROVED, unavailable: VEHICLE_STATUS.REMOVED };

const VEHICLE_STATUS_LABELS = {
  [VEHICLE_STATUS.PENDING]: 'Pending approval',
  [VEHICLE_STATUS.APPROVED]: 'Approved',
  [VEHICLE_STATUS.REJECTED]: 'Rejected',
  [VEHICLE_STATUS.REMOVED]: 'Removed'
};

/* --------------------------------------------------------- rental bookings */
const BOOKING_STATUS = {
  PENDING: 'pending',
  PAYMENT_PENDING: 'payment_pending',
  PENDING_OWNER: 'pending_owner',       // paid, waiting for the owner
  CONFIRMED: 'confirmed',              // owner approved
  APPROVED: 'approved',                // legacy alias of confirmed
  REJECTED: 'rejected',                // owner declined the paid request
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',              // legacy umbrella value
  CANCELLED_BY_USER: 'cancelled_by_user',
  CANCELLED_BY_OWNER: 'cancelled_by_owner',
  CANCELLED_BY_ADMIN: 'cancelled_by_admin'
};

const BOOKING_CANCELLED_STATUSES = [
  BOOKING_STATUS.CANCELLED,
  BOOKING_STATUS.CANCELLED_BY_USER,
  BOOKING_STATUS.CANCELLED_BY_OWNER,
  BOOKING_STATUS.CANCELLED_BY_ADMIN
];

/** Statuses that still hold a vehicle slot. */
const BOOKING_ACTIVE_STATUSES = [
  BOOKING_STATUS.PENDING,
  BOOKING_STATUS.PAYMENT_PENDING,
  BOOKING_STATUS.PENDING_OWNER,
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.APPROVED,
  BOOKING_STATUS.COMPLETED
];

const BOOKING_STATUS_LABELS = {
  [BOOKING_STATUS.PENDING]: 'Pending',
  [BOOKING_STATUS.PAYMENT_PENDING]: 'Awaiting payment',
  [BOOKING_STATUS.PENDING_OWNER]: 'Awaiting owner approval',
  [BOOKING_STATUS.CONFIRMED]: 'Confirmed',
  [BOOKING_STATUS.APPROVED]: 'Approved',
  [BOOKING_STATUS.REJECTED]: 'Rejected by owner',
  [BOOKING_STATUS.COMPLETED]: 'Completed',
  [BOOKING_STATUS.CANCELLED]: 'Cancelled',
  [BOOKING_STATUS.CANCELLED_BY_USER]: 'Cancelled by user',
  [BOOKING_STATUS.CANCELLED_BY_OWNER]: 'Cancelled by owner',
  [BOOKING_STATUS.CANCELLED_BY_ADMIN]: 'Cancelled by admin'
};

const PAYMENT_STATUS = { PENDING: 'pending', PAID: 'paid', FAILED: 'failed', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded' };

/* ---------------------------------------------------------- ride bookings */
const RIDE_BOOKING_STATUS = {
  PAYMENT_PENDING: 'payment_pending',  // seat held, payment not finished
  PENDING_OWNER: 'pending_owner',      // paid, waiting for the owner
  CONFIRMED: 'confirmed',             // owner approved the request
  REJECTED: 'rejected',               // owner declined the paid request
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',             // legacy umbrella value
  CANCELLED_BY_USER: 'cancelled_by_user',
  CANCELLED_BY_OWNER: 'cancelled_by_owner',
  CANCELLED_BY_ADMIN: 'cancelled_by_admin'
};

const RIDE_BOOKING_CANCELLED_STATUSES = [
  RIDE_BOOKING_STATUS.CANCELLED,
  RIDE_BOOKING_STATUS.CANCELLED_BY_USER,
  RIDE_BOOKING_STATUS.CANCELLED_BY_OWNER,
  RIDE_BOOKING_STATUS.CANCELLED_BY_ADMIN
];

/** A ride booking still consumes seats while it is in one of these states. */
const RIDE_BOOKING_ACTIVE_STATUSES = [
  RIDE_BOOKING_STATUS.PAYMENT_PENDING,
  RIDE_BOOKING_STATUS.PENDING_OWNER,
  RIDE_BOOKING_STATUS.CONFIRMED,
  RIDE_BOOKING_STATUS.COMPLETED
];

const RIDE_BOOKING_STATUS_LABELS = {
  [RIDE_BOOKING_STATUS.PAYMENT_PENDING]: 'Awaiting payment',
  [RIDE_BOOKING_STATUS.PENDING_OWNER]: 'Awaiting owner approval',
  [RIDE_BOOKING_STATUS.CONFIRMED]: 'Seat confirmed',
  [RIDE_BOOKING_STATUS.REJECTED]: 'Rejected by owner',
  [RIDE_BOOKING_STATUS.COMPLETED]: 'Ride completed',
  [RIDE_BOOKING_STATUS.CANCELLED]: 'Cancelled',
  [RIDE_BOOKING_STATUS.CANCELLED_BY_USER]: 'Cancelled by user',
  [RIDE_BOOKING_STATUS.CANCELLED_BY_OWNER]: 'Cancelled by owner',
  [RIDE_BOOKING_STATUS.CANCELLED_BY_ADMIN]: 'Cancelled by admin'
};

/** Who initiated a cancellation. */
const CANCELLED_BY = { USER: 'user', OWNER: 'owner', ADMIN: 'admin' };

/**
 * Maps a cancellation actor to the status value stored on the record.
 *
 * The single place the `cancelled_by_*` strings are assembled, so the rental
 * route, the ride route and the admin routes cannot drift into producing
 * `cancelled_user` in one place and `cancelled_by_user` in another.
 * An unknown actor falls back to the legacy umbrella value, never to a
 * privileged one.
 */
function cancelledStatusFor(kind, flow = 'rental') {
  const actor = String(kind || '').toLowerCase();
  if (!CANCELLED_BY[actor.toUpperCase()]) {
    return flow === 'ride' ? RIDE_BOOKING_STATUS.CANCELLED : BOOKING_STATUS.CANCELLED;
  }
  return `cancelled_by_${actor}`;
}

function isCancelled(value) {
  return BOOKING_CANCELLED_STATUSES.includes(value) || RIDE_BOOKING_CANCELLED_STATUSES.includes(value);
}

function labelFor(value, map) {
  return map[value] || value || 'Unknown';
}

module.exports = {
  RIDE_STATUS,
  RIDE_STATUS_ALIASES,
  RIDE_STATUS_LABELS,
  PUBLIC_RIDE_STATUSES,
  VEHICLE_STATUS,
  VEHICLE_STATUS_ALIASES,
  VEHICLE_STATUS_LABELS,
  BOOKING_STATUS,
  BOOKING_STATUS_LABELS,
  BOOKING_ACTIVE_STATUSES,
  BOOKING_CANCELLED_STATUSES,
  PAYMENT_STATUS,
  RIDE_BOOKING_STATUS,
  RIDE_BOOKING_STATUS_LABELS,
  RIDE_BOOKING_ACTIVE_STATUSES,
  RIDE_BOOKING_CANCELLED_STATUSES,
  CANCELLED_BY,
  cancelledStatusFor,
  isCancelled,
  labelFor
};

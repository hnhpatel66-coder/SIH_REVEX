# REVEX 1.3

**Move Smart. Share More.**

A vehicle **rental** and shared **ride** platform with three portals — rider, owner and
admin — built on Node.js, Express and MongoDB.

This release merges the previous REVEX application with a redesigned user interface, a
Razorpay payment reference and a chatbot API reference, and rebuilds the parts of the
product that did not work end to end.

---

## Table of contents

1. [What is in this release](#1-what-is-in-this-release)
2. [Requirements](#2-requirements)
3. [Install and run](#3-install-and-run)
4. [Environment variables](#4-environment-variables)
5. [MongoDB setup](#5-mongodb-setup)
6. [Razorpay payments](#6-razorpay-payments)
7. [The REVEX Assistant](#7-the-revex-assistant)
8. [Pricing and the cancellation policy](#8-pricing-and-the-cancellation-policy)
9. [How the product works](#9-how-the-product-works)
10. [Project layout](#10-project-layout)
11. [API reference](#11-api-reference)
12. [Tests](#12-tests)
13. [Maintenance scripts](#13-maintenance-scripts)
14. [Deployment](#14-deployment)
15. [Troubleshooting](#15-troubleshooting)
16. [Security notes](#16-security-notes)

---

## 1. What is in this release

### The two approvals are now genuinely separate

This is the change that matters most, and it is easy to get wrong.

| Approval | Who decides | What it unlocks |
|---|---|---|
| The **ride offer** | **Admin** | The ride becomes visible and bookable on Find a Ride |
| The **seat request** | **Owner** | A paid rider's seat is confirmed |

They are stored in different collections (`Ride.status` and `RideBooking.status`) and
exposed by different endpoints. An owner approving a rider never publishes the ride, and
an admin approving a ride never confirms a seat.

### Payments are real, and the backend is the authority

* A rider **pays immediately** when booking — there is no "book now, pay later".
* The **order is created by the server** and the **signature is verified by the
  server**. The browser is never trusted with an amount.
* A failed, forged or replayed callback cannot create a second paid booking.
* With no Razorpay keys configured, the payment screen offers a clearly labelled
  **test payment**. It is a real server-side state change stored with
  `paymentMethod: "demo"` and a `REVEX-RIDE-TEST-…` reference, so it can never be
  mistaken for money. The server refuses that path entirely once a gateway is present.

### One definition of every amount

`backend/utils/ridePricing.js` is the single definition of what a rider pays. The card,
the booking panel, the Razorpay order and the stored booking all read from it, so the
four numbers cannot disagree. The browser sends a seat count and nothing else.

### One definition of cancellation

`backend/utils/cancellation.js` holds the whole policy and every number is
environment-configurable — there is no hard-coded percentage anywhere in the code. The
fee and the refund always add back up to the amount paid, and whatever is not refunded
is always described as platform fee, owner compensation or cancellation fee.

Users, owners and admins can all cancel where the rules allow. **No record is ever
deleted** — a cancellation keeps its status, its reason and its refund outcome as an
audit trail.

### The vehicle photo is reused, not uploaded twice

The owner’s *Offer a Ride* form now picks one of their **registered vehicles** and reuses
that vehicle’s photo, number plate, category and fuel type. This is the fix for "the
vehicle image is missing in Find a Ride": the offer points at the vehicle record instead
of holding a separate upload. Owners with no approved vehicle can still type the details
manually.

### Profile pictures

`User.photo` is a real, validated, account-level field. The navbar avatar, the profile
page and both admin lists show the same picture. Uploads are validated the same way as
vehicle photos (raster types only, never SVG, size limited).

### Rebuilt admin Owner Summary

One request, `GET /api/admin/owners/:id`, returns the whole dashboard: summary cards,
vehicles, ride offers, rental and ride bookings, the revenue split, activity counters and
documents. Inside it an admin can view, verify, reject, disable and remove a vehicle
without deleting anything.

### A consistent interface

The reference design arrived as six stacked stylesheets that each redefined buttons,
cards and badges. They are replaced by **one** `css/revex-ui.css` built on the project’s
own theme tokens, so light and dark both work and the app reads as one product. Status
badges, toasts, confirmation dialogs and image fallbacks all come from one shared
implementation in `js/main.js`.

### Authenticated, per-user assistant

The reference chatbot kept the conversation in `localStorage` and accepted anonymous
requests, so nothing loaded on a new device and a hand-edited storage key could read
another account’s messages. Here every endpoint requires a session, conversations are
stored in MongoDB scoped to `userId`, and the provider is chosen by `CHAT_API_URL`
(Gemini or any OpenAI-compatible endpoint).

---

## 2. Requirements

| | |
|---|---|
| Node.js | **18 or newer** (`node -v`) |
| npm | 9 or newer |
| MongoDB | Atlas (recommended) or a local `mongod` |
| Razorpay | optional — without keys a labelled test payment is used |
| A chat API key | optional — without one the assistant says so in the UI |

There is **no build step**. The frontend is plain HTML, CSS and JavaScript; the backend is
plain CommonJS. `npm install` is the only setup.

---

## 3. Install and run

```bash
# 1. install
npm install

# 2. configure
cp .env.example .env          # Windows: copy .env.example .env
#    then fill in MONGODB_URI, JWT_SECRET and ADMIN_PASSWORD

# 3. run
npm start
```

Open <http://localhost:5001>.

The server serves the frontend **and** the API from the same origin, so no CORS
configuration is needed in the normal setup.

> **Why not open the HTML files directly?** Opening `index.html` from VS Code Live Server
> or a Vite dev server makes the browser request `<that-origin>/api/...`, which never
> reaches the backend. `js/main.js` detects exactly that case and points the API at
> `http://localhost:5001/api`; the network error message also names the origin it tried,
> so the problem is diagnosable instead of a generic failure.

### Creating the first admin

On first boot the server creates the admin named by `ADMIN_EMAIL` / `ADMIN_PASSWORD` if
no admin exists yet. If an account already exists under that email but is **not** an
admin, the server refuses to promote it silently and tells you to use
`admin-setup.html` with `ADMIN_SETUP_KEY`.

```bash
npm run setup-admin           # interactive
```

---

## 4. Environment variables

`backend/.env` is read first, then the project-root `.env`. Keep secrets in **one**
place. `.env.example` documents every name with an empty or obviously-fake value — it
contains no credentials and no cluster hostname.

### Required

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Connection string. **Include the database name in the path** — Atlas otherwise silently connects to a database called `test`. |
| `JWT_SECRET` | Token signing key. The server refuses to start without it. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Bootstrap admin, used only when no admin exists yet |

### Optional but recommended

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5001` | Injected automatically by Render/Railway/Vercel — do not set it there. |
| `PUBLIC_URL` | `http://localhost:5001` | Base URL used to build password-reset links. |
| `MONGODB_DB_NAME` | `vroomy` | Used when `MONGODB_URI` does not name a database. |
| `ALLOW_LOCAL_MONGO_FALLBACK` | `false` | Keep `false` in production so data can never land in the wrong database. |
| `ADMIN_SETUP_KEY` | *(empty)* | Enables `/api/auth/setup-admin`. Empty disables the endpoint. |
| `AUTH_RATE_LIMIT_MAX` | per-route defaults | Raise it **only** when running the end-to-end suite. |
| `CORS_ALLOWED_ORIGINS` | *(empty)* | Needed only when the frontend is on a different host. |

### Payments, money and the assistant

See sections [6](#6-razorpay-payments), [8](#8-pricing-and-the-cancellation-policy) and
[7](#7-the-revex-assistant).

---

## 5. MongoDB setup

### Atlas (recommended)

1. Create a free M0 cluster.
2. **Database Access** → add a user with *Read and write to any database*.
3. **Network Access** → allow your own IP (or `0.0.0.0/0` for a shared demo only).
4. Copy the SRV string and **append the database name**:

   ```
   mongodb+srv://<user>:<password>@<cluster>.mongodb.net/vroomy
   ```

5. Put it in `.env` as `MONGODB_URI`.

### Local MongoDB

```env
MONGODB_URI=mongodb://127.0.0.1:27017/vroomy
MONGODB_FALLBACK_URI=mongodb://127.0.0.1:27017/vroomy
```

### Checking the connection

```bash
curl http://localhost:5001/api/health
# {"ok":true,"database":"connected","databaseName":"vroomy","mode":"atlas"}
```

`"database":"disconnected"` means the server is up but MongoDB is not.

### A non-fatal warning you may see

```
[rides] The database-level guard "active_ride_booking_unique" could not be created
        because N duplicate live ride booking pair(s) already exist. ...
        node scripts/fix-duplicate-ride-bookings.js
```

A database that was live before 1.3 can already contain two live seat requests from the
same rider on the same ride, and MongoDB cannot create the unique index while that is
true. **The API refuses new duplicates either way**, so no new double-booking is
possible. To finish the repair:

```bash
node scripts/fix-duplicate-ride-bookings.js --dry-run   # report only
node scripts/fix-duplicate-ride-bookings.js             # merge and index
```

The script keeps one booking per pair, marks the rest `cancelled` with a reason, and
never deletes anything.

---

## 6. Razorpay payments

### The server checks the keys, it does not assume them

`RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` being non-empty does **not** mean payments
work. A revoked, mistyped or mismatched pair passes every "is it set?" test and then
fails every real order, which previously left the app with no way to pay and no way to
tell the operator why.

So the server **probes** Razorpay at boot and caches the answer for five minutes
(`RAZORPAY_HEALTH_TTL_MS`):

```
[config] Razorpay          = keys present (rzp_test_xxxxxxxx), verifying…
[gateway] Razorpay accepted the API keys. Real payments are enabled.
```

or, when the keys are refused:

```
[gateway] Razorpay is NOT usable (rejected).
[gateway]   Razorpay rejected this server's API credentials. … check RAZORPAY_KEY_ID
            and RAZORPAY_KEY_SECRET in the backend .env file and restart the server.
            Your session is unaffected and no money has moved.
```

`GET /api/payments/config` reports the same state to the browser:

| Field | Meaning |
|---|---|
| `enabled` | both env variables are non-empty |
| `usable` | Razorpay actually accepted them — **this is what decides the payment path** |
| `state` | `ready` \| `missing` \| `rejected` \| `unreachable` |
| `testModeAvailable` | always `!usable` |
| `testModeLabel` | names the reason, e.g. *Test payment (Razorpay rejected the server keys)* |

The client, both booking screens and the server-side guard on the test-payment
endpoint all read `usable`, so they cannot disagree.

### A gateway failure never looks like an expired session

Razorpay answers `401` when **the server's** keys are wrong. That used to be forwarded
to the browser as our own `401`, and since the frontend treats a `401` on an
authenticated request as an expired session, **the rider was silently logged out
mid-checkout** and told their session had expired.

Upstream credential failures are now mapped to `502` (`utils/payments.js` →
`mapUpstreamStatus`), with a message that names the two variables to fix and states
plainly that the rider's session is unaffected. No route returns `401` for a payment
problem; `tests/integrations.test.js` enforces that.

### Test-payment mode (no keys, or refused keys)

Leave the two Razorpay variables **empty**, or set keys that Razorpay rejects, and the
payment screens offer a clearly labelled test payment. It is a real server-side state
change, stored with `paymentMethod: "demo"` and a `REVEX-…-TEST-…` reference, so it can
never be mistaken for real money.

The server refuses a test payment with `409` whenever `usable` is true, so a browser
with a stale cached config cannot record a demo payment while real payments work.

### Live mode

1. Get your keys from the Razorpay dashboard.
2. Set them in `.env`:

   ```env
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx
   ```

3. Restart the server and look for `[gateway] Razorpay accepted the API keys.`
4. Add `https://checkout.razorpay.com/v1/checkout.js` to your CSP if you set one.

The checkout script is loaded **once** per page and the whole settlement is guarded by a
single latch, so a double click cannot create two bookings for one payment. The
checkout window is tinted with the live `--brand` token, so it matches the app in both
themes instead of using a hard-coded colour.

### Diagnosing a payment problem

```bash
node scripts/probe-integrations.js   # checks the Razorpay keys and the assistant key
node scripts/verify-live.js          # exercises both against a running server
```

`probe-integrations.js` prints only whether each value is present — never the value,
not even a prefix.

### What the server checks

| Check | Where |
|---|---|
| The signature is a valid HMAC of `order_id\|payment_id` | `utils/payments.js` |
| The signature comparison is constant-time | `utils/payments.js` |
| The order id belongs to **this** booking | `routes/rides.js`, `routes/bookings.js` |
| The collected amount equals the amount due | `gateway.verifyCheckout({ expectedAmountPaise })` |
| A duplicate callback is idempotent | `booking.paymentStatus === 'paid'` short-circuit |
| A failed verification releases the held seats | the cancel branch |

There is no npm dependency for the gateway: the REST calls are made over `node:https`, so
the project installs even if the optional `razorpay` SDK is absent.

### Refunds

Refunds are issued through `gateway.refund()` and recorded on the booking
(`booking.refund`). A gateway failure is **never swallowed** — it is stored with
`status: "failed"` and a note, so an operator can finish it manually. The booking
history and the admin reports both show the outstanding amount.

---

## 7. The REVEX Assistant

The assistant is available to every signed-in account (rider, owner and admin) as a
launcher on every page, and as a full page at `chat.html`. The admin panel has its own
**Chat** tab.

### Configuration — one key is enough

| Variable | Required | Example |
|---|---|---|
| `CHAT_API_KEY` | **yes** | your provider key |
| `CHAT_API_URL` | no | derived automatically for Google; set it only for another provider |
| `CHAT_API_MODEL` | no | `gemini-2.5-flash` |
| `CHAT_TEMPERATURE` | no | `0.35` |
| `CHAT_MAX_OUTPUT_TOKENS` | no | `450` |
| `CHAT_TIMEOUT_MS` | no | `20000` |

**Put in your key and restart. That is the whole setup.** When `CHAT_API_URL` is empty,
the official `:generateContent` endpoint is derived from the key and the model name, so
the startup log reads:

```
[config] REVEX Assistant   = configured (gemini-2.5-flash, endpoint derived from the key)
```

This was a real bug in 1.3.0: the endpoint URL was treated as a second mandatory
secret, so a perfectly valid key still produced *"not configured"* and every message
returned `503`. The endpoint is a constant, not a secret.

`GEMINI_API_KEY` and `GEMINI_MODEL` are still read as fallbacks, so the reference
project's variable names keep working unchanged.

### Using a different provider

Set `CHAT_API_URL` and the wire format follows from it. A base is completed for you, so
all of these work:

| You set | The app calls |
|---|---|
| *(nothing)* | `…/v1beta/models/<model>:generateContent` (Gemini) |
| `https://host/v1beta/models` | `…/v1beta/models/<model>:generateContent` |
| `https://host/v1beta/models/x:generateContent` | exactly that |
| `https://host/v1` | `https://host/v1/chat/completions` (OpenAI-compatible) |
| `https://host/v1/chat/completions` | exactly that |

The endpoint must be `https`; plain `http` is allowed only for `localhost`, so a typo
cannot leak the key in the clear.

**With no key at all nothing breaks**: the chat screen loads and says exactly which
variable to set. It never pretends to answer.

### When a provider call fails

Failures are classified rather than lumped together, because each needs a different
action from the reader — an exhausted daily quota looks exactly like an outage if you
only say "unavailable":

| `kind` | What happened | What the user is told |
|---|---|---|
| `quota` | the account is out of requests for the day | try again later today |
| `rateLimit` | too many requests in a short window | try again in *N* seconds (also sent as `Retry-After`) |
| `credentials` | the assistant key is wrong or not authorised | the **operator** must check the key |
| `timeout` | the provider was too slow | try again |
| `provider` | anything else upstream | temporarily unavailable |

An upstream `401` is reported to the browser as `502`, never as `401`, so a bad
assistant key can never be mistaken for an expired user session and log anyone out.

The user's message is stored **before** the provider is called, so an outage never loses
what someone typed.

### Privacy

* Every endpoint requires a session.
* Conversations live in MongoDB, scoped to `userId`; one account can never read
  another's.
* The API key never leaves the server, and `/api/chat/status` masks it out of the URL it
  echoes back.
* Assistant output is inserted with `textContent`, never as HTML, and the system prompt
  asks for plain text — the transcript renders literally, so `**bold**` would otherwise
  be shown with the asterisks attached.

### Light and dark

`css/chat.css` holds the widget's whole palette as `--revex-chat-*` custom properties,
and the dark block redefines **only** those properties, so no rule is duplicated and
the widget cannot drift from the reference design in one theme.

`scripts/sync-ui-tokens.js` holds this file to a stricter rule than the rest of the UI
layer: every `--revex-chat-*` token must be defined in the light block **and** in the
dark block. A token defined in only one is exactly the failure this project shipped once
— a panel that kept its light background in dark mode and became white text on white.

Measured contrast, both themes: panel 16.4:1, assistant bubble 16.4:1, input 15.9:1,
suggestion chip 6.4:1, send button 5.0:1, safety note 4.8:1.

### Endpoints

```
GET    /api/chat/status                    is the assistant available?
GET    /api/chat/conversations             my recent conversations
POST   /api/chat/conversations             start a new one
GET    /api/chat/conversations/:id         one conversation
DELETE /api/chat/conversations/:id         delete it
POST   /api/chat                           send a message
```

---

## 8. Pricing and the cancellation policy

### Ride pricing

```
Base ride amount        = seats x fare per seat
+ Extras                = ride.additionalCharges   (tolls, pickup fee, …)
+ Platform fee          = (base + extras) x PLATFORM_FEE_PERCENT
− Discount              = (base + extras + fee) x ride.discountPercent
---------------------------------------------------------------
= Total payable
```

The owner receives `OWNER_SHARE_RATE` (90%) of the total and the platform keeps the rest.
`/api/admin/income` and the Owner Summary both report the split, and the tests assert
that owner share + platform share equals the gross exactly.

### Cancellation policy

Every number below is read from the environment on every cancellation. There is no
hard-coded percentage anywhere in the code.

| Variable | Default | Meaning |
|---|---|---|
| `CANCEL_FREE_WINDOW_HOURS` | `6` | Cancelling this many hours **before the start** is free. **`0` disables the free window** — it does not mean "always free". |
| `CANCEL_FEE_PERCENT_USER` | `10` | Fee kept when the **rider** cancels. |
| `CANCEL_FEE_PERCENT_OWNER` | `25` | Fee kept when the **owner** declines or cancels. |
| `CANCEL_FEE_PERCENT_ADMIN` | `0` | Fee kept when an **admin** cancels. |
| `CANCEL_FEE_FLAT_USER` / `_OWNER` / `_ADMIN` | `0` | Flat fee added on top of the percentage. |
| `CANCEL_FEE_MAX_USER` / `_OWNER` / `_ADMIN` | `1500` / `2500` / `0` | Ceiling for the fee. `0` means no ceiling. |
| `CANCEL_OWNER_PENALTY_MULTIPLIER` | `1` | Multiplier on an owner-caused fee. |
| `PLATFORM_FEE_PERCENT` | `10` | Platform commission, used by both quotes and every revenue split. |

Guarantees, all covered by tests:

* `fee + refund === amount paid`, always, to the paisa.
* A fee never exceeds the amount paid and a refund is never negative.
* An unpaid record is never charged a fee.
* Every cancellation stores who cancelled, when, why, the fee, the refund, the policy
  version and a human explanation.

### Preview before you commit

Both flows expose a preview endpoint, and the UI calls it **before** showing the
confirmation dialog — so the fee and refund the user sees are the exact numbers that will
be applied, not an estimate written in the browser.

```
GET /api/bookings/:id/cancellation-preview
GET /api/rides/bookings/:id/cancellation-preview
```

---

## 9. How the product works

### Rider

1. Register as a rider.
2. **Find a Ride** → search by route, date and vehicle type. Only admin-approved offers
   appear.
3. Open a ride, choose seats, accept the terms, **Pay & Book Ride**.
4. Your seat request waits for the driver. You can cancel at any time and see the exact
   fee and refund first.
5. **Rent a Vehicle** → browse approved vehicles with real photos, pick dates, accept
   the agreement, pay.

### Owner

1. Switch to an owner account from the profile page.
2. **List a vehicle** with a photo and documents. An admin approves it.
3. **Offer a Ride** → pick a registered vehicle (its photo and plate are reused), set the
   route, date, time, seats and price per seat. An admin approves the **offer**.
4. **Ride Requests** → only **paid** requests appear. Approve a seat, or decline and
   refund under the policy.
5. **Rental Requests** → approve or decline a paid rental request.
6. Track vehicle-wise earnings.

### Admin

The control centre has twelve tabs:

`Dashboard` · `Owners` · `Vehicles` · `Ride Approvals` · `Rental Bookings` ·
`Ride Bookings` · `Payments` · `Agreements` · `Reports` · `Users` · `Chat` · `Settings`

* **Owners** → open an owner for the full Owner Summary dashboard.
* **Vehicles** → approve, reject, **remove** (keeps the record) or delete permanently.
* **Ride Approvals** → owner, vehicle, photo, registration, route, timing, seats, price
  and documents for every offer waiting on a decision.
* **Ride Bookings** → confirm, complete, or cancel with an automatic refund.
* **Payments** → the gateway ledger, with a live/dashboard filter.
* **Reports** → revenue per vehicle, per owner and per rental booking, with the split.

---

## 10. Project layout

```
revex_1_3/
├── index.html … admin.html        18 pages, plain HTML
├── chat.html                      full-page assistant
├── ride-requests.html             owner: paid seat requests
├── css/
│   ├── style.css cards.css navbar.css responsive.css theme.css   (base + theme)
│   ├── revex-ui.css               THE consolidated component layer
│   └── chat.css                   assistant only
├── js/
│   ├── main.js                    shared helpers + window.REVEX namespace
│   ├── payment.js                 shared Razorpay client (one settle() latch)
│   ├── chat.js chat-page.js       the assistant
│   ├── rides.js                   Find a Ride, ride details, Offer a Ride
│   ├── ride-requests.js           owner seat requests
│   ├── rental.js pricing.js       rental flow
│   ├── booking.js                 My Bookings (rental + ride)
│   ├── owner.js                   owner portal
│   ├── admin.js                   admin control centre
│   ├── profile-page.js            profile + avatar
│   ├── theme.js confirm-delete.js
├── backend/
│   ├── server.js                  Express app + boot reconciliation
│   ├── models/                    User Vehicle Booking Ride RideBooking
│   │                              Payment Agreement Review Notification
│   │                              MonthlyBookingCounter ChatConversation
│   ├── routes/                    auth vehicles bookings rides admin
│   │                              notifications chat payments
│   └── utils/
│       ├── statuses.js            ONE status vocabulary
│       ├── ridePricing.js         ONE ride quote
│       ├── pricing.js             rental quote
│       ├── cancellation.js        ONE cancellation policy
│       ├── payments.js            ONE Razorpay client
│       ├── media.js earnings.js notify.js security.js db.js hardDelete.js
├── api/index.js                   Vercel / serverless entry point
├── scripts/                       maintenance + repair + packaging
├── tests/                         offline suites + the end-to-end API suite
├── .env.example  backend/.env.example
└── README.md
```

---

## 11. API reference

All routes are under `/api`. Protected routes need `Authorization: Bearer <token>`.

### Auth — `/api/auth`

```
POST   /register            POST /login             POST /logout
GET    /me                  POST /edit-profile      POST /switch-role
POST   /forgot-password     POST /reset-password    POST /setup-admin
```

### Vehicles — `/api/vehicles`

```
GET    /                    public list (approved only)
GET    /mine                the signed-in owner's vehicles
GET    /:id                 one vehicle + live availability
GET    /:id/quote           backend-calculated rental quote
GET    /price-suggestion    transparent price helper
POST   /                    create            PUT /:id            DELETE /:id
```

### Rental bookings — `/api/bookings`

```
GET    /my                  GET /my-agreements        GET /owner/summary
GET    /owner/requests      GET /:id
POST   /                    create
POST   /:id/payment-order   create a Razorpay order
POST   /:id/verify-payment  server-side signature verification
POST   /:id/payment-test    labelled test payment (refused if a gateway exists)
POST   /:id/payment-failed  release an abandoned checkout
GET    /:id/cancellation-preview
POST   /:id/cancel          user / owner / admin, with refund
POST   /:id/owner-decision  owner approves or declines (declining refunds)
POST   /:id/feedback        rating + review
GET    /:id/agreement       PDF      GET /:id/agreement/details
POST   /:id/agreement/owner-accept   POST /:id/agreement/user-sign
```

### Ride sharing — `/api/rides`

```
GET    /                    public list (admin-approved offers only)
GET    /mine                the owner's offers          GET /requests  paid seat requests
GET    /bookings/my         the rider's seat requests
GET    /:id                 one offer
GET    /:id/quote?seats=N   backend-calculated quote
POST   /                    create an offer
PATCH  /:id                 edit while pending
POST   /:id/cancel           withdraw the offer
POST   /:id/book            claim seats + create a payment-pending booking
POST   /bookings/:id/payment-order
POST   /bookings/:id/verify-payment
POST   /bookings/:id/payment-test
POST   /bookings/:id/payment-failed
POST   /bookings/:id/decision   owner approves or declines (declining refunds)
GET    /bookings/:id/cancellation-preview
POST   /bookings/:id/cancel      rider / owner / admin, with refund
POST   /bookings/:id/complete    POST /bookings/:id/feedback
```

### Admin — `/api/admin` (admin only)

```
GET    /summary                  GET /users           GET /owners
GET    /owners/:id               THE Owner Summary dashboard
GET    /vehicles                 GET /vehicles/:id    vehicle drill-down
PATCH  /vehicles/:id/verify      PATCH /vehicles/:id/status
DELETE /vehicles/:id             hard delete (reason + confirm required)
GET    /ride-approvals           the approval queue
GET    /ride-bookings            PATCH /ride-bookings/:id/status
PATCH  /rides/:id/verify         PATCH /rides/:id/remove
DELETE /rides/:id                remove and refund every paid seat
GET    /bookings                 PATCH /bookings/:id/status
GET    /income                   GET /payments
GET    /agreements               POST /create-admin
DELETE /users/:id
```

### Assistant — `/api/chat` (session required)

```
GET  /status   GET /conversations   POST /conversations
GET  /conversations/:id   DELETE /conversations/:id   POST /
```

### Payments — `/api/payments`

```
GET  /config    is Razorpay live?  (public — the secret is never returned)
GET  /mine      the caller's own payments
GET  /          the full ledger (admin)
GET  /:id       one receipt, scoped to its payer, owner or an admin
```

---

## 12. Tests

### Offline suites — no database, no network, no server

```bash
npm test
```

| Suite | What it pins |
|---|---|
| `pricing.test.js` | the rental quote |
| `ride-pricing.test.js` | the ride quote: fees, extras, discounts, clamping, availability, the revenue split |
| `cancellation-policy.test.js` | the policy: free window, per-actor fees, ceilings, the money identity, refund plans |
| `statuses.test.js` | the status vocabulary and its backward compatibility |
| `validation.test.js` | form validation helpers |
| `frontend-contract.test.js` | the promises the UI makes: Pay & Book Ride, no client-side total, no fake payment success, photo reuse, no hard-coded cancellation percentages, no `alert()`/`prompt()` |
| `cross-file-helpers.test.js` | no page script shadows a shared helper; every page loads the shared layer in order |
| `no-duplicate-routes.test.js` | no duplicated route, no literal route shadowed by a parameter |
| `responsive-a11y.test.js` | viewport, titles, descriptions, button types, field labels, live regions, breakpoints, reduced motion |
| `security.test.js` | no committed secret, no fallback JWT secret, secrets never reach the browser, uploads validated, escaping |
| `registration-regression.test.js` | the original "Create Account fails" root cause stays fixed |
| `theme.test.js` | light/dark, no flash of the wrong theme |
| `cors.test.js` | same-origin, and an unrelated origin is not granted access |
| `deployment.test.js` | same-origin behind a proxy, `PORT`, static serving |

The runner also asserts that **every maintenance script is idempotent**, so
`npm run sync` never produces a diff for the next person.

### End-to-end API suite — needs a running server

```bash
# the server under test needs a raised rate limit: the suite registers several
# accounts, and the default 10-per-15-minutes limit is correct in production
set AUTH_RATE_LIMIT_MAX=500      # Windows cmd
# export AUTH_RATE_LIMIT_MAX=500 # macOS / Linux / Git Bash
npm start

# in another shell
set TEST_BASE_URL=http://localhost:5001
set ADMIN_EMAIL=you@example.com
set ADMIN_PASSWORD=your-password
npm run test:api
```

142 checks drive the whole flow: register → list a vehicle → admin approves → offer a
ride → admin approves the offer → book and pay → owner approves → owner declines (refund)
→ rider cancels (refund) → admin cancels (refund) → assistant → owner summary → revenue
identities → overbooking → permissions → CORS.

It also covers the failure paths: a forged signature, a replayed callback, an
already-paid booking, and a caller reaching somebody else's booking.

The payment block branches on `usable`, the **probed** gateway state, not on `enabled`
(which only means the env variables are non-empty). So it exercises the right path in
all three situations — working keys, no keys, and keys Razorpay rejects — and in the
rejected case it asserts the two properties that were previously broken:

* the order attempt returns `502`, never `401`, so the rider is not logged out;
* the message names `RAZORPAY_KEY_ID`, so the operator knows what to fix.

### Integration regressions — `tests/integrations.test.js`

Fully offline, no server needed. Each block pins a bug that shipped in 1.3.0 and was
found by probing the live providers rather than by reading the code:

| Block | The bug it prevents |
|---|---|
| a bare key configures the assistant | a valid Gemini key reporting "not configured" |
| endpoint completion | a valid OpenAI URL getting `/chat/completions` twice |
| transport safety | the key sent over plain `http` |
| failure classification | a daily quota looking like an outage |
| a gateway 401 is never ours | the rider logged out mid-checkout |
| availability is probed | a rejected key leaving no way to pay at all |
| real gateway ids | a legitimate payment id rejected as malformed |
| no undefined globals | `chat-page.js` calling an undefined `api()` |
| the widget follows the theme | white text on a white panel in dark mode |
| the panel matches the reference | the panel sitting on top of the launcher |

### Diagnosing the two integrations

```bash
node scripts/probe-integrations.js   # are the keys present, and does the provider answer?
node scripts/verify-live.js          # exercise both against a running server
```

Both print only whether a value is present — never the value, not even a prefix.

### Other suites

`tests/e2e.test.js`, `cluster.test.js`, `hard-delete.test.js`, `availability.test.js` and
`filters.test.js` need a running server or a disposable database. `npm test` lists them
at the end so nothing looks accidentally skipped.

---

## 13. Maintenance scripts

```bash
npm run sync        # run every sync script
npm run sync:ui     # stylesheet + script order on every page
npm run sync:meta   # page titles and descriptions
npm run sync:tokens # UI layer must use tokens the theme actually defines
npm run sync:buttons  # every <button> gets an explicit type
npm run sync:labels   # every field label is associated with its control
```

Each accepts `--check`, which **exits non-zero** instead of writing, so they work as CI
gates. `npm test` runs all of them in check mode.

Other scripts:

```bash
npm run check                     # node --check every .js file
npm run db:audit                  # database audit report
npm run db:inspect                # inspect collections
npm run db:reset                  # drop and reseed (DESTRUCTIVE)
npm run db:reset-users:dry        # report what the account wipe would remove
npm run db:reset-users            # refuse without --yes
npm run db:fix-duplicate-ride-bookings
npm run pack                      # build %USERPROFILE%\Downloads\revex_1_3.zip
```

### Starting from an empty database — `db:reset-users`

Most evaluations and demos want a clean slate with exactly one account of each role.
`npm run db:reset-users` does that:

```bash
npm run db:reset-users:dry     # prints every collection and its row count
npm run db:reset-users -- --yes
```

**This is destructive.** It **drops** every collection except `users` — vehicles, rides,
bookings, payments, agreements, reviews, notifications and chat conversations are
deleted, not archived — then **deletes every user** and creates exactly three with known
passwords. It prints the credentials when it finishes.

It is safe by design:

* it refuses to run without `--yes`, and `--dry-run` reports without changing anything;
* it refuses to empty a database whose name is not in an allow-list, so a stray
  `MONGODB_URI` cannot wipe something unrelated;
* it takes the admin email from `ADMIN_EMAIL`, so the server's own `ensureAdmin()` does
  not create a fourth admin on the next boot;
* it re-creates the unique index on `email`, so the first duplicate registration cannot
  quietly make a second account;
* it verifies the result and exits non-zero if anything other than three users, one per
  role, is left.

The passwords are printed by the script rather than hard-coded in this README, so they
cannot drift out of sync with the code.

### Packaging a copy that runs with no setup

```bash
# shareable: no credentials inside (the default)
npm run pack

# local build: includes backend/.env so it runs the moment it is extracted
node scripts/pack.js C:\path\to\REVEX_LOCAL.zip --include-env
```

`--include-env` puts your Atlas URI and password, JWT secret, Razorpay keys and assistant
API key inside the archive. That is right for a copy you run yourself and wrong for a
file you send to anyone. It is opt-in and has to be typed every time, only
`backend/.env` is let through, and the packer prints a warning banner when it is used.

### Why the sync scripts exist

Each one prevents a bug that actually happened here:

* **sync-ui-layer** — six stylesheets in the wrong order meant the same button rendered
  differently on two pages.
* **sync-page-meta** — titles and descriptions were added by hand and half the pages had
  none.
* **sync-ui-tokens** — the new UI layer was written against `--card` / `--text` /
  `--accent`, which the theme does not define. A silent `var(--wrong, #fff)` fallback
  looked fine in light mode and made the chat panel white-on-white in **dark** mode.
* **sync-button-types** — `<button>` defaults to `type="submit"`, so a control later
  moved inside a form starts submitting it.
* **sync-field-labels** — the field pattern used a `<span>`, so a screen reader announced
  the input as "edit text, blank".

### Where the ZIP goes, and why not the Desktop

`npm run pack` writes to **`%USERPROFILE%\Downloads\revex_1_3.zip`** by default.

That is deliberate. On a machine where **Desktop** and **Documents** are redirected
into OneDrive, OneDrive deletes a freshly written ZIP from the Desktop within seconds
— this happened twice while building this release. `C:\Users\DELL\Downloads` is a real
local folder that OneDrive does not manage, so the archive survives there and can be
copied to a USB stick, a shared drive or an email attachment.

The packer also writes the archive itself rather than shelling out to
`Compress-Archive`, because `Compress-Archive` stores entry names with **backslashes**.
Windows Explorer copes with that, but macOS Archive Utility, Linux `unzip` and Python's
`zipfile` treat a backslash name as one long filename and flatten the whole project.
`pack.js` writes forward slashes, as the ZIP specification requires, so the archive
extracts correctly everywhere.

```bash
npm run pack                                    # -> %USERPROFILE%\Downloads\revex_1_3.zip
node scripts/pack.js "D:\Transfer\revex_1_3.zip" # anywhere else you like
```

---

## 14. Deployment

### Render / Railway / Fly (recommended)

* **Build command:** `npm install`
* **Start command:** `npm start`
* **Health check path:** `/api/health`

Set every variable from section [4](#4-environment-variables) in the platform's
environment-variable panel. `PORT` is injected automatically — do not set it.

### Vercel

`api/index.js` is the serverless entry point and `vercel.json` is included. The runtime
config route is registered **before** the SPA catch-all, so `/rev-runtime.js` is never
answered with `index.html`.

### Checklist before going live

- [ ] `JWT_SECRET` is a fresh 48-byte random value, not the one from development.
- [ ] `ADMIN_PASSWORD` changed; `ADMIN_SETUP_KEY` set to something strong or left empty.
- [ ] `ALLOW_LOCAL_MONGO_FALLBACK=false`.
- [ ] `CORS_ALLOWED_ORIGINS` set if the frontend is on a different host.
- [ ] `PUBLIC_URL` is the real HTTPS origin.
- [ ] Razorpay **live** keys, and the dashboard's allowed domains updated.
- [ ] SMTP configured if you want real password-reset email.
- [ ] `CHAT_API_KEY` set, or the assistant left unconfigured on purpose.
- [ ] `npm test` green.

---

## 15. Troubleshooting

**"Cannot reach the REVEX backend at …"**
The page was served from a different origin than the API. Start the backend and reload;
the message names the exact URL it tried.

**`{"ok":true,"database":"disconnected"}`**
The server is running but MongoDB is not reachable. Check `MONGODB_URI`, that the
database name is in the path, and that your IP is in the Atlas network-access list.

**Connected to a database called `test`**
`MONGODB_URI` has no database name in the path. Append `/vroomy`, or set
`MONGODB_DB_NAME`.

**Payments say "Online payment is not configured"**
`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are empty, so the app is in test-payment mode
by design. The payment screen offers a labelled test payment.

**The test payment is refused with 409**
A gateway is configured, so the test path is disabled on the server. Use the real
checkout.

**`JWT_SECRET is missing`**
The server refuses to start. Put it in `backend/.env` or the project-root `.env`.

**The admin dashboard is empty**
The admin role is granted through `admin-setup.html` with `ADMIN_SETUP_KEY`, or by
setting `ADMIN_EMAIL` / `ADMIN_PASSWORD` before the first boot. An existing non-admin
account is never promoted silently.

**Every `Find a Ride` card says "Not bookable"**
The offer has not been approved by an admin yet, or all its seats are held.

**A status shows as `Unknown`**
An unrecognised stored value is shown verbatim rather than hidden. Check
`backend/utils/statuses.js` — new values must be added there.

---

## 16. Security notes

* **No secret is committed.** `.env.example` contains names and empty values only — not
  even a cluster hostname, because a stray copy-paste would point a new install at
  somebody else's database. `tests/security.test.js` fails if a live credential shape
  appears anywhere.
* **`.env` and `node_modules` are never packaged.** `npm run pack` refuses to build if
  either is still on the list, and the ZIP contains neither.
* **`JWT_SECRET` has no default.** The server throws on boot without it, and neither
  entry point silently falls back to a literal.
* **The secret key never reaches the browser.** Only the publishable Razorpay key id is
  returned. The chat key is masked out of the URL the status endpoint echoes.
* **Config diagnostics report presence, not value.** The JWT secret is logged by length.
* **Uploads are validated by type and size.** Raster types only; SVG is rejected because
  it can carry script. Combined upload size is checked before the request is sent.
* **User input is escaped** before it reaches `innerHTML`; assistant output is inserted as
  text. `tests/security.test.js` asserts the escaping at the render sites that matter.
* **CORS is same-origin by default.** A request whose `Origin` matches the host it was
  sent to is always allowed; anything else needs `CORS_ALLOWED_ORIGINS`, and the response
  varies by `Origin` so a CDN cannot cross-serve it.
* **Nothing is silently deleted.** Cancelling, removing a vehicle and removing a ride
  all keep the record; only the explicitly-confirmed deletes in
  `js/confirm-delete.js` remove data, and they require a typed reason.

---

## Licence

Private project. All rights reserved.

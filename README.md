# REVEX � Vehicle Rental & Shared Ride Platform

REVEX is a full-stack vehicle rental and shared-ride application built with Node.js, Express, MongoDB and vanilla HTML/CSS/JavaScript. It has separate User, Owner and Admin portals with server-enforced role authorization.

## Features

- JWT authentication, password reset flow and account deactivation
- Role-based User / Owner / Admin navigation and API authorization
- Vehicle listings with category, fuel type, transmission, odometer, photos and documents
- Duplicate number-plate protection (application validation plus a MongoDB unique index)
- Transparent rental pricing: base rental, duration, included/extra kilometres, additional charges, tax/fees, paid and remaining amounts
- Mandatory rental agreement and Terms & Conditions before payment
- Demo payment plus optional Razorpay order/verification endpoints
- Owner booking-request inbox with approve/reject actions
- Admin vehicle moderation queue with document preview/download
- Owner summary and vehicle-wise earnings
- Soft vehicle deregistration with reason and historical-record preservation
- Star-based vehicle/ride reviews
- Responsive dark UI for desktop, tablet and mobile

## Project structure

```
Revex_1_0/
+-- api/index.js                 # Vercel/serverless Express entry
+-- backend/
�   +-- server.js                # Local Express server
�   +-- models/                  # User, Vehicle, Booking, Agreement, Payment, Review, Notification, Ride
�   +-- routes/                  # Auth, vehicles, bookings, rides, admin, notifications
�   +-- middleware/auth.js
�   +-- utils/                   # Pricing and notification helpers
+-- css/                         # Shared responsive styles
+-- js/                          # Frontend modules
+-- *.html                       # Public, owner, user and admin pages
+-- .env.example
+-- vercel.json
```

## Local setup

Requirements: Node.js 18+ and MongoDB (Atlas or local).

1. Install dependencies:

```bash
npm install
```

2. Copy the environment template and fill in real values:

```bash
cp .env.example .env
# Windows PowerShell: Copy-Item .env.example .env
```

The server also reads `backend/.env` when that file exists. Do not commit either real environment file.

3. Start the application:

```bash
npm start
```

The local server runs at `http://localhost:5001` by default. Health check:

```text
GET http://localhost:5001/api/health
```

4. Optional demo data:

```bash
npm run seed
```

The seed script preserves existing records and only creates missing demo records. Configure `ADMIN_PASSWORD` before seeding if you want a known bootstrap admin; no default password is stored in this repository.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | Yes in Atlas deployments | MongoDB connection string |
| `MONGODB_DB_NAME` | No (default `vroomy`) | Database used when the URI does not name one. Without it Atlas silently uses `test`. |
| `MONGODB_FALLBACK_URI` | No | Local MongoDB fallback (only used when `ALLOW_LOCAL_MONGO_FALLBACK=true`) |
| `ALLOW_LOCAL_MONGO_FALLBACK` | No (default `false`) | Permits falling back to local MongoDB. Keep `false` in production so data is never written to localhost. |
| `PORT` | No (default `5001`) | Express port |
| `JWT_SECRET` | Yes | Long random JWT signing secret |
| `ADMIN_EMAIL` | Recommended | Bootstrap admin email |
| `ADMIN_PASSWORD` | First run only | Bootstrap admin password |
| `ADMIN_NAME` | No | Bootstrap admin display name |
| `ADMIN_SETUP_KEY` | Optional | One-time `/auth/setup-admin` key |
| `ENABLE_DEMO_RESET` | No | Explicitly enables local demo reset links |
| `DEMO_OWNER_PASSWORD` | No | Password used only when the optional demo owner is created by the seed script |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | No | Real payment gateway |
| `FRONTEND_URL` | No | Restricts CORS in a deployment |
| `PRICING_BASE_BIKE` / `PRICING_BASE_SCOOTER` / `PRICING_BASE_CAR` / `PRICING_BASE_OTHER` | No | Configurable price-suggestion base values |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## Appearance: dark and light mode

REVEX ships with two interchangeable themes. The light theme is the default
design; the dark theme is a token override, so both use exactly the same
components.

- **Switch anywhere:** the toggle sits in the top navigation on every page, and
  the profile page has a full Light / Dark chooser under *Appearance*.
- **Persisted** in `localStorage` under `revexTheme` and applied on every page.
- **No flash on load:** a tiny inline script in each `<head>` sets
  `data-theme` before first paint.
- **Respects the OS:** on a first visit the theme follows
  `prefers-color-scheme`, and keeps following it live until you pick manually.

Implementation: `css/theme.css` (token overrides + toggle styles) and
`js/theme.js` (state, persistence, delegated click handling). The light tokens
stay on `:root` in `css/style.css`; `[data-theme="dark"]` overrides them.

Override the API or theme per page with:

```html
<meta name="revex-api-base" content="https://api.example.com/api">
```

## Permanent delete (vehicles and accounts)

Vehicles and accounts are **hard deleted**, not deactivated. Deleting removes
the record from MongoDB and from every screen, together with everything that
only existed to support it:

| Deleting a vehicle also removes | Deleting an account also removes |
|---|---|
| its bookings, agreements, payments, reviews | every vehicle they listed (and those vehicles' bookings) |
| its notifications and monthly booking slots | their bookings, agreements, payments, reviews, notifications |
| | their ride offers, seat bookings and booking counters |

Safety rules enforced on the server:

- a **reason is mandatory** (kept as the audit trail)
- the client must send `confirm: true` or the request is rejected with
  `CONFIRMATION_REQUIRED`
- only the owning owner or an admin may delete a vehicle
- an admin **cannot delete their own account**
- the **last remaining admin can never be deleted**, so the portal cannot lock itself out

The confirmation dialog (`js/confirm-delete.js`) lists exactly what will be
removed before the user commits.

Legacy rows created by the old soft-delete behaviour are cleaned up with:

```bash
npm run purge:legacy          # dry run, lists everything
npm run purge:legacy -- --apply
```

## Frontend API configuration

The frontend never hard-codes a server address. `js/main.js` resolves the API
base at runtime:

1. `<meta name="revex-api-base" content="http://localhost:5001/api">` in the page head (per-page override)
2. `window.REVEX_API_BASE` set before `js/main.js` loads
3. `/api` when the page is served by the REVEX server itself (ports 5000/5001, or no port in production)
4. `http://<current-host>:5001/api` when the page is served by a *different* dev server

Step 4 exists because a purely relative `/api` breaks the moment `index.html`
or `register.html` is opened from VS Code Live Server, Live Preview, Vite or
any other origin: the browser sends the request to that origin, it never
reaches the backend, and the form fails with an opaque error.

To point the frontend at a different backend without editing code, add to the
page `<head>`:

```html
<meta name="revex-api-base" content="https://api.your-domain.com/api">
```

## Registration: root cause of the "Create Account fails" bug

Two independent defects made registration fail from the real form. **Neither
was related to MongoDB or JWT.**

1. **Missing `Content-Type` header.** Several pages passed an already
   stringified body to `api()`. The old helper only set
   `Content-Type: application/json` when the body was *not* a string, so those
   requests went out with no content type. `express.json()` only parses
   `application/json`, so `req.body` arrived as `{}` and the backend correctly
   but confusingly replied *"Name, email and password are required."* for a
   perfectly valid payload. This affected **register, login, forgot-password,
   reset-password and admin-setup**. `api()` now always declares the content
   type, and a backend fallback parses a JSON body that arrives without one.
2. **Relative-only API base.** See the section above.

The backend also returns a `code` on errors (`VALIDATION_ERROR`,
`EMAIL_EXISTS`, `DATABASE_UNAVAILABLE`, `REGISTRATION_FAILED`) and logs a
step-by-step trace of the registration flow without ever logging passwords,
hashes, tokens or secrets.

## Roles and permissions

### User

- Register/login, find and filter rental vehicles, view photos and details
- Accept the rental agreement, pay, view bookings and agreements
- Cancel eligible bookings and submit a star review

### Owner

- Add, edit and soft-deregister vehicles
- Upload photos and ownership/insurance/PUC documents
- Receive a Booking Requests inbox immediately after a booking is created
- Approve or reject requests with a reason
- View owner dashboard, fleet status and vehicle-wise earnings

### Admin

- Review and verify vehicle documents
- Approve, reject or deregister individual vehicles without leaving the moderation page
- View owner summary, vehicle-wise booking counts and earnings
- Manage bookings, users, ride offers, reports and additional admins

All privileged operations are protected by `requireAuth` and `requireRole` on the server. Hiding a navigation item is never the only protection.

## Rental flow

`Select vehicle ? Booking details ? Agreement & Terms ? Mandatory acceptance ? Payment ? Owner approval ? Booking confirmation`

The server recalculates the quote from the stored vehicle configuration. The client displays the same breakdown and the booking stores a pricing snapshot. A direct API request without `agreementAccepted: true` is rejected.

## Main API routes

### Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `POST /api/auth/switch-role`
- `POST /api/auth/edit-profile`
- `GET /api/auth/me`

### Vehicles

- `GET /api/vehicles` (public approved listings)
- `GET /api/vehicles/price-suggestion`
- `GET /api/vehicles/:id/quote`
- `GET /api/vehicles/mine` (owner/admin)
- `POST /api/vehicles` (owner/admin)
- `PUT /api/vehicles/:id` (owner/admin; plate changes are admin-only)
- `DELETE /api/vehicles/:id` (soft deregistration)

### Bookings and agreements

- `POST /api/bookings`
- `POST /api/bookings/:id/payment-order`
- `POST /api/bookings/:id/verify-payment`
- `POST /api/bookings/:id/payment-failed`
- `GET /api/bookings/my`
- `GET /api/bookings/owner/summary`
- `GET /api/bookings/owner/requests`
- `POST /api/bookings/:id/owner-decision`
- `GET /api/bookings/:id/agreement/details`
- `GET /api/bookings/:id/agreement` (PDF)
- `POST /api/bookings/:id/feedback`

### Rides

- `GET /api/rides`
- `GET /api/rides/mine` (owner/admin)
- `POST /api/rides` (owner/admin)
- `POST /api/rides/:id/book`
- `POST /api/rides/bookings/:id/payment-order`
- `POST /api/rides/bookings/:id/verify-payment`
- `POST /api/rides/bookings/:id/payment-failed`
- `POST /api/rides/bookings/:id/feedback`

### Admin

- `GET /api/admin/summary`
- `GET /api/admin/owners`
- `GET /api/admin/owners/:id`
- `GET /api/admin/agreements` (search `?search=`, filter `?status=`)
- `GET /api/admin/agreements/:id`
- `GET /api/admin/vehicles`
- `PATCH /api/admin/vehicles/:id/verify`
- `DELETE /api/admin/vehicles/:id` (reason required)
- `GET /api/admin/bookings`
- `PATCH /api/admin/bookings/:id/status`
- `GET /api/admin/income`
- `GET /api/admin/users`
- `POST /api/admin/create-admin`
- `DELETE /api/admin/users/:id` (soft deactivation)

## Data safety

Existing records are migrated conservatively. Legacy vehicle statuses are normalized from `available`/`unavailable` to `approved`/`removed`; old bookings retain their totals and payment history. Vehicles are soft-deregistered rather than destroyed when they have history. Monthly booking capacity is released when a booking is cancelled, payment fails or an owner rejects a request.

## Verification performed

Automated checks (no database required):

```bash
npm run check        # syntax-checks every .js file in the project
npm test             # pricing + validation unit tests
```

Integration checks (require a running server and `backend/.env`):

```bash
npm start            # in one terminal
npm run test:e2e     # 39 end-to-end checks: auth, roles, vehicles, booking,
                     # agreement, payment, admin agreements, owner summary,
                     # earnings reversal, password reset, authorization
npm run test:filters # 10 checks: search filters, image pipeline, PII exposure
npm run test:cluster  # 13 checks: new-cluster acceptance (register, login, JWT,
                      # admin, owner, vehicle, booking, restart)
npm run test:hard-delete # 13 checks: permanent delete + referential cascade
npm run db:audit     # MongoDB integrity: duplicate plates, orphan records, totals
npm run cluster:verify # confirms the NEW Atlas cluster, db name, admin seed, hashing
npm run qa:cleanup   # dry-run listing of leftover qa.* test records (--apply to remove)
```

`npm run test:e2e`, `npm run test:filters` and `npm run test:cluster` require a
reachable server at `http://localhost:5001` and create/remove their own
`qa.*` test records.

> The auth rate limiter allows 10 registrations per IP per 15 minutes by default.
> The E2E suite registers several accounts, so set `AUTH_RATE_LIMIT_MAX=2000` in
> `backend/.env` and restart the server before running it. The suite detects a
> rate-limited run and aborts with a clear message instead of failing obscurely.

## External services

The following are **not** exercised by the automated tests because they need
real third-party credentials:

- **Email delivery** � the reset flow generates and stores a 1-hour token
  correctly, but no SMTP account is configured. Set `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` to enable delivery. Without them the
  endpoint still returns the same generic message so it cannot be used to
  discover which emails are registered. For local testing set
  `ENABLE_DEMO_RESET=true` to receive the reset link in the response.
- **Razorpay payments** � the code path exists but is inert until
  `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set. The demo payment flow is
  the default and is fully tested.
- **Cloud storage** � photos and documents are stored as base64 data URLs inside
  MongoDB. `uploads/` static serving is wired up for legacy path-based records.

## Razorpay Standard Checkout

REVEX uses Razorpay Standard Checkout for rental payments.

- `POST /api/bookings/:id/payment-order` creates a server-side Razorpay order from the stored booking total.
- `POST /api/bookings/:id/verify-payment` verifies `razorpay_order_id`, `razorpay_payment_id` and `razorpay_signature` using HMAC-SHA256.
- `vehicle-details.html` loads the Razorpay Checkout script and opens the payment modal after the booking is created.
- `RAZORPAY_KEY_SECRET` is server-only and must never be exposed to browser code.
- Local secrets belong in `.env`; `.env` is ignored by Git.

Install the Node SDK with:

```bash
npm install razorpay
```

For local testing, configure `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `.env`, start the server, create a rental booking, and click **Pay with Razorpay**.

## Deployment

Vercel uses `api/index.js` as the serverless entry point. Set all environment variables in the Vercel project settings. For local development use `npm start`; do not point local development at the serverless export.

## License

MIT License.

## Backend dependency setup

The backend has its own dependency declarations. If you start the server from the `backend` directory, run:

```bash
cd backend
npm install
npm start
```

Do not commit `.env` files. Razorpay credentials must remain in environment variables; only the public Razorpay Key ID may be exposed to the browser.

## REVEX Assistant (Gemini chatbot)

A floating **Ask REVEX** assistant is available at the bottom-right of every top-level page. The frontend calls `POST /api/chat`; the Gemini secret remains on the server.

Configuration lives in `.env`:

```env
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
```

Restart the server after changing `.env`. Run `npm run check:chatbot` to verify the integration without making a Gemini request.

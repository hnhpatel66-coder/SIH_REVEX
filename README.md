# REVEX — Vehicle Rental & Shared Ride Platform

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
├── api/index.js                 # Vercel/serverless Express entry
├── backend/
│   ├── server.js                # Local Express server
│   ├── models/                  # User, Vehicle, Booking, Agreement, Payment, Review, Notification, Ride
│   ├── routes/                  # Auth, vehicles, bookings, rides, admin, notifications
│   ├── middleware/auth.js
│   └── utils/                   # Pricing and notification helpers
├── css/                         # Shared responsive styles
├── js/                          # Frontend modules
├── *.html                       # Public, owner, user and admin pages
├── .env.example
└── vercel.json
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

The local server runs at `http://localhost:5000` by default. Health check:

```text
GET http://localhost:5000/api/health
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
| `MONGODB_FALLBACK_URI` | No | Local MongoDB fallback |
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

`Select vehicle → Booking details → Agreement & Terms → Mandatory acceptance → Payment → Owner approval → Booking confirmation`

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
- `POST /api/bookings/:id/payment-demo`
- `POST /api/bookings/:id/verify-payment`
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
- `POST /api/rides/bookings/:id/payment-demo`
- `POST /api/rides/bookings/:id/feedback`

### Admin

- `GET /api/admin/summary`
- `GET /api/admin/owners`
- `GET /api/admin/owners/:id`
- `GET /api/admin/vehicles`
- `PATCH /api/admin/vehicles/:id/verify`
- `DELETE /api/admin/vehicles/:id` (reason required)
- `GET /api/admin/bookings`
- `PATCH /api/admin/bookings/:id/status`
- `GET /api/admin/income`
- `GET /api/admin/users`
- `DELETE /api/admin/users/:id` (soft deactivation)

## Data safety

Existing records are migrated conservatively. Legacy vehicle statuses are normalized from `available`/`unavailable` to `approved`/`removed`; old bookings retain their totals and payment history. Vehicles are soft-deregistered rather than destroyed when they have history. Monthly booking capacity is released when a booking is cancelled, payment fails or an owner rejects a request.

## Verification performed

The project was checked with:

```bash
npm run check
```

The implementation was exercised against a connected MongoDB test database for registration, role authorization, duplicate plates, owner CRUD, document upload, admin approve/reject, public visibility, quote calculation, agreement enforcement, demo payment, owner requests, approval, review submission, notifications, account deactivation and cancelled-booking rebooking.

## Deployment

Vercel uses `api/index.js` as the serverless entry point. Set all environment variables in the Vercel project settings. For local development use `npm start`; do not point local development at the serverless export.

## License

MIT License.

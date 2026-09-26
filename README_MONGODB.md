# REVEX MongoDB notes

## Start locally

From the project root:

```bash
npm install
npm start
```

Open `http://localhost:5001`. The server reads `backend/.env` and then `.env`; never commit either real environment file.

## Environment

Required for a real deployment:

- `MONGODB_URI`
- `JWT_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD` (only needed to bootstrap the first admin)

Optional: `MONGODB_FALLBACK_URI`, `ADMIN_SETUP_KEY`, `ENABLE_DEMO_RESET`, Razorpay keys and `FRONTEND_URL`.

## Demo data

`npm run seed` creates a demo owner only when it is missing. Set `DEMO_OWNER_PASSWORD` before running it; the password is never stored in source control:

- Email: `demo.owner@vroomy.local`
- Password: value of `DEMO_OWNER_PASSWORD`

Change or remove the demo account before using a shared or production database.

## Data flow

Frontend ? Express REST API ? Mongoose ? MongoDB Atlas.

All booking and vehicle IDs are MongoDB ObjectIds. Existing records are migrated conservatively and are not deleted by startup. Vehicle deregistration is a soft status change so historical bookings remain available.

## Main API

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/vehicles`
- `GET /api/vehicles/price-suggestion`
- `POST /api/vehicles` (owner/admin only)
- `GET /api/vehicles/mine` (owner/admin only)
- `POST /api/bookings` (requires agreement acceptance)
- `GET /api/bookings/my`
- `GET /api/bookings/owner/requests` (owner/admin only)
- `GET /api/admin/summary` (admin only)

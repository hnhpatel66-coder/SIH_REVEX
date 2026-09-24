# REVEX — Working MongoDB Prototype

## Run
1. Install Node.js 18+.
2. Extract this folder.
3. Run `START_REVEX.bat`.
4. Open http://localhost:5000
5. Health: http://localhost:5000/api/health

The startup script runs the MongoDB demo seed first, then starts the API.

## MongoDB
`backend/.env` is configured with the MongoDB URI supplied for this hackathon.
The app first tries Atlas and then falls back to:
`mongodb://127.0.0.1:27017/vroomy`

Existing MongoDB data is not deleted by startup or seed.

## Admin
Admin account is repaired/created automatically in the configured MongoDB:
- Email: `admin@vroomy.com`
- Password: `Admin@12345`

Run `SETUP_ADMIN.bat` if you want to repair only the admin account.

## Demo owner
- Email: `demo.owner@vroomy.local`
- Password: `Demo@12345`

## Demo data
`SEED_DEMO_DATA.bat` adds Bike, Scooter and Car vehicles plus shared rides if they do not already exist.

## Working flows
- User/Owner registration and JWT login
- Owner List & Earn
- Bike/Scooter/Car vehicle listing
- Admin vehicle approve/reject
- Rental search and vehicle booking
- PAN + Driving Licence capture
- Simple demo payment
- Rental agreement PDF
- Ride publishing
- Ride seat booking + demo payment
- My Bookings for rentals and rides
- Booking cancellation
- Owner earnings (90%)
- REVEX commission (10%)
- Admin summary and transaction/booking visibility

## Important
The included `.env` contains credentials supplied for this prototype. Do not publish it to a public Git repository. Rotate the MongoDB password after the hackathon if this credential has been shared.


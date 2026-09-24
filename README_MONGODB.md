# REVEX - MongoDB Hackathon Build

## Start
Open a terminal in `backend`:

```bash
npm install
npm run seed
npm start
```

Open: http://localhost:5000

## Environment
The backend reads `backend/.env`. Do not commit `.env` to GitHub.

Required:
- PORT
- MONGODB_URI
- JWT_SECRET

## Demo owner
- Email: demo.owner@vroomy.local
- Password: Demo@12345

## Important
Use an Owner account on **List & Earn**. A normal renter account cannot create vehicle listings.

## Data flow
Frontend -> Express REST API -> Mongoose -> MongoDB Atlas

Vehicle booking IDs always use MongoDB ObjectIds. The frontend does not connect directly to MongoDB.

## Main API
- POST /api/auth/register
- POST /api/auth/login
- GET /api/vehicles
- POST /api/vehicles
- GET /api/vehicles/mine
- GET /api/vehicles/:id
- POST /api/bookings
- GET /api/bookings/my
- GET /api/health


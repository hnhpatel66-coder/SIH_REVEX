# START HERE — `revex_map_back_1_0`

A complete, running copy of the REVEX platform: frontend, backend, database, every
API, Razorpay, the Mapbox map and the chatbot. Everything needed to run it is in
this folder, including `node_modules` and the `.env`.

---

## Run it

Double-click **`START_REVEX.bat`**, or from a terminal in this folder:

```bash
npm start
```

Then open **http://localhost:5001**

Sign in with the admin account already in `backend/.env`
(`ADMIN_EMAIL` / `ADMIN_PASSWORD`), or register a new account.

`node_modules` is included, so this works offline with no `npm install` step.

---

## What is in the box

| | |
|---|---|
| **Frontend** | 18 HTML pages + `js/`, `css/` — rider, owner and admin portals |
| **Backend** | `backend/` — Express, 11 Mongoose models, 8 route groups, 19 utility modules |
| **APIs** | `/api/auth` `/api/rides` `/api/vehicles` `/api/bookings` `/api/payments` `/api/chat` `/api/notifications` `/api/admin` |
| **Map** | Mapbox GL JS basemap + Smart Route road matching, town checkpoints and distance markers (`js/route-map.js`, `backend/utils/{geo,mapbox,smartRoute,rideRoute}.js`) |
| **Payments** | Razorpay orders, verification and a labelled test-payment fallback (`backend/utils/payments.js`) |
| **Chatbot** | REVEX Assistant on Gemini (`backend/utils/chatProvider.js`, `backend/routes/chat.js`) |
| **Database** | Live MongoDB via `backend/.env`, **plus** a full JSON export in `database/` |
| **Serverless** | `api/index.js` for Vercel |

---

## The database

`backend/.env` points at a **live MongoDB Atlas cluster**, so the app works the
moment you start it. But a remote cluster is not something that travels inside a
folder — so the data is also exported to plain JSON in `database/`:

```
database/
  index.json              what was exported, when, how many documents
  collections/*.json      12 collections, 55 documents
```

**Re-create that export from any machine:**

```bash
npm run db:export
```

**Load an export into a database:**

```bash
npm run db:import -- --dry-run     # report what it would do, write nothing
npm run db:import                   # insert only missing documents
npm run db:import -- --wipe         # wipe and reload  (local MongoDB only)
```

The importer **refuses to write to an Atlas cluster** unless you pass
`--allow-live`, because a restore is the one operation here that can destroy
real data.

To use a local MongoDB instead of Atlas, set these in `backend/.env`:

```
ALLOW_LOCAL_MONGO_FALLBACK=true
MONGODB_FALLBACK_URI=mongodb://127.0.0.1:27017/vroomy
```

---

## ⚠️ `backend/.env` contains real secrets

As requested, this copy ships the **real** keys so it runs without setup:

- MongoDB Atlas URI, username and password
- `JWT_SECRET`
- Razorpay key id and key secret
- Gemini API key
- Mapbox secret (`sk.`) and public (`pk.`) tokens
- Admin email and password

**Treat this folder the way you would treat the live database.** Before sharing
it — by email, cloud drive, upload, or a public repository:

1. Delete `database/` (it holds every user record).
2. Delete `backend/.env`.
3. Copy `backend/.env.example` to `backend/.env` and paste in fresh keys.
4. Rotate every key listed above at its provider, because they have now been
   copied off the original machine.

`npm run pack` builds a shareable zip that leaves `.env` and `database/` out
automatically.

---

## Verify it works

```bash
npm test            # 23 offline check groups, no server or database needed
```

Live checks against a running server:

| Check | Expect |
|---|---|
| `GET /api/health` | `ok: true` |
| `GET /api/rides/map-config` | `enabled: true`, token starts `pk.` |
| `GET /api/rides/smart-search?from=Rajkot&to=Ahmedabad` | 218.7 km, `provider: mapbox`, towns + distance marks |
| `GET /api/chat/status` | `configured: true` |

### Pinning either end of your journey

On **Find a Ride** and on a **ride's own page** you can type your pickup and drop,
or pin either of them on the map. The two are independent: pin a pickup and type a
drop, type a pickup and pin a drop, or pin both. A pin always wins over the text
box beside it, and a pin with no drop still means "ride to where the driver is
going", exactly as before.

To check the pinned-drop path end to end without a browser, pin two points on one
ride's road and read back the leg:

```bash
# Dwarka -> Nadiad. Board at Jamnagar, leave at Dholka: both ends pinned.
curl "http://localhost:5001/api/rides/<RIDE_ID>/route?pickupLng=70.0577&pickupLat=22.4707&dropLng=72.4422&dropLat=22.7272"
```

Expect `match.ok: true`, `mode: "partial"`, and a `riderKm` well below the ride's
`totalKm` — the leg is measured from the pickup pin to the drop pin, not to the
driver's destination. Drop `dropLng`/`dropLat` and the same call returns
`mode: "pin"` with a `riderKm` of the whole remaining road, which is the
pre-existing behaviour.

The map needs a network round-trip to Mapbox, so the first paint takes a second
or two. If the basemap cannot load, the page says so in plain words and falls
back to a drawn route diagram rather than showing an empty box.

---

## Troubleshooting

**"MONGO_URI is not set" / cannot connect** — the Atlas cluster may be paused or
the IP allow-list may not include this machine. Check `backend/.env`, then
`node scripts/inspect-db.js`.

**Razorpay `usable: false`, "Too many requests"** — Razorpay is rate-limiting
this IP. It is upstream, not a bug. The app keeps working and uses a clearly
labelled test payment; no real money moves.

**Chat says not configured** — the Gemini key in `backend/.env` is missing,
expired, or out of quota.

**Map is a plain diagram** — `MAPBOX_PUBLIC_TOKEN` is missing or invalid. The
Smart Route matching still works without it (it falls back to the key-free
public OSRM router and a built-in gazetteer), you just do not get the Mapbox
basemap.

**Port 5001 already in use** — change `PORT` in `backend/.env`.

---

## Layout

```
revex_map_back_1_0/
  *.html            18 pages
  js/  css/         frontend
  api/index.js      Vercel serverless entry
  backend/
    server.js  seed.js  setup-admin.js
    .env  .env.example
    models/ routes/ middleware/ utils/
  database/         JSON export of every collection
  scripts/          pack, sync checks, db tools, export/import
  tests/            23 offline groups
  node_modules/     included
  START_REVEX.bat   double-click to run
```

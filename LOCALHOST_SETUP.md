# REVEX 1.5 Localhost Setup

## Windows

1. Make sure Node.js 18+ and MongoDB Community Server are installed.
2. Start MongoDB on `127.0.0.1:27017`.
3. Open this project folder.
4. Run `START_REVEX.bat`.

### Direct backend start
If you open `backend` manually, `npm start` is self-healing: it checks for the required backend packages and runs `npm install` automatically if they are missing.

```text
cd backend
npm start
```

The server uses the local database configured in `backend/.env`:
`mongodb://127.0.0.1:27017/vroomy`

Website: http://localhost:5001
Health: http://localhost:5001/api/health

Demo admin: `admin@vroomy.local` / `Admin@12345`
Demo owner: `demo.owner@vroomy.local` / `Demo@12345`

If `npm install` cannot download packages, check your internet connection/proxy and run it once manually from the `backend` directory.

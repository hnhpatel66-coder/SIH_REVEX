# REVEX combined UI integration

This release is based on the full uploaded `SIH_REVEX(2).zip` and preserves the original project files.

## Included changes

- Login page receives the unified sign-in loading/success/error interaction.
- Dynamic REVEX navigation uses role-aware routes and Header-2-inspired responsive styling.
- LoadingButton behavior is bridged to the production vanilla-JS app for search, ride submission, vehicle submission, rental preparation and ride booking/payment states.
- Find a Ride Smart Route uses Mapbox when a publishable token works and falls back to an interactive Leaflet + OpenStreetMap basemap when Mapbox is missing/unavailable.
- Matching ride geometries are displayed on the map. Clicking a route selects the corresponding ride card; clicking a ride card selects its map route.
- Pickup/drop pinning remains supported on the interactive map.
- The original backend/API/database/Android/test/deployment files are retained.

## Architecture

The production application remains vanilla HTML/CSS/JavaScript so the existing backend and portals continue to run unchanged. The supplied React/shadcn source components live under `/components/ui` for future React usage and are backed by TypeScript/Tailwind/shadcn configuration files.

## Local setup

From the project root:

```bash
npm install
npm start
```

Optional TypeScript source check:

```bash
npm run ui:typecheck
```

The runtime does not require a React build step.

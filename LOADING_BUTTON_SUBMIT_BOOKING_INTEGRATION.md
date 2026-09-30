# REVEX LoadingButton integration — Submit + Booking

This release integrates the supplied React/shadcn `LoadingButton` into the existing vanilla REVEX pages without rewriting the application.

## Integrated actions
- `offer-ride.html`: **Submit ride offer**
- `ride-details.html`: **Pay & Book Ride**
- `vehicle-details.html`: **Review agreement & continue**

The React button owns the loading/success/error presentation. The existing REVEX JavaScript continues to own validation, API calls, booking creation, payment and redirects.

## Local setup
From the project root:

```cmd
npm install
npm start
```

`npm start` automatically builds the React LoadingButton bundle when it is missing, then starts the existing Express backend.

If you prefer manual build:

```cmd
npm run ui:build
npm start
```

## Backend-folder compatibility
The backend `package.json` also contains the runtime dependencies, so `cd backend && npm install` is supported. Start the full application from the project root for the React bundle build:

```cmd
cd ..
npm install
npm start
```

## shadcn structure
The supplied component remains at:
`components/ui/loading-button.tsx`

The React integration entry is:
`react-ui/src/loading-button-mount.tsx`

No Unsplash images or new logo assets are required. The supplied inline SVG status icons are part of the provided component and are not replacing any REVEX logos.

# REVEX LoadingButton / shadcn integration

## Important architecture note

REVEX v1.4.0 is currently a vanilla HTML/CSS/JavaScript application, not a React application.
It does not currently have a React entry point, Tailwind build pipeline, or TypeScript build pipeline.

To avoid rewriting the existing production UI, this release adds an isolated React component layer under `components/` and `react-ui/`.
The existing REVEX pages remain unchanged.

## Added structure

- `components/ui/loading-button.tsx` — requested component
- `components/loading-button-demo.tsx` — requested demo
- `components.json` — shadcn-compatible configuration
- `tsconfig.json` — TypeScript configuration with `@/*` alias
- `react-ui/` — minimal Vite + React + Tailwind build entry
- `assets/react-ui/` — build output destination

`/components/ui` is the conventional shadcn UI component directory. Keeping the component there makes future shadcn CLI additions and imports predictable.

## Install

From the project root:

```bash
npm install
```

The required runtime dependency is:

```bash
npm install motion react react-dom
```

The React/Tailwind/TypeScript tooling is included in `devDependencies`:

```bash
npm install -D typescript vite @vitejs/plugin-react tailwindcss postcss autoprefixer @types/react @types/react-dom
```

## Run the isolated component demo

```bash
npm run ui:dev
```

Then open the Vite URL shown in the terminal.

## Build

```bash
npm run ui:build
```

The compiled assets are written to `assets/react-ui/`.

## shadcn CLI note

Because the existing REVEX application is not a React app, running `npx shadcn@latest init` against the whole project would be inappropriate without first choosing a React framework/build target.

For a new standalone React app, the normal setup is:

```bash
npm create vite@latest revex-react-ui -- --template react-ts
cd revex-react-ui
npm install
npx shadcn@latest init
npm install tailwindcss postcss autoprefixer
```

This release already provides the equivalent structure/configuration needed for the isolated component layer, so you do not need to recreate the whole REVEX app.

## Best place to use LoadingButton

For REVEX, the most natural future integration point is the `Search rides` action in `find-ride.html`, because the action has an asynchronous backend/search lifecycle.

The current production button was intentionally not replaced automatically: the page is vanilla JavaScript and cannot import `.tsx` directly. Replacing it safely requires mounting the React bundle into that page and wiring its promise to the existing `searchNow()` lifecycle.

No backend, MongoDB, Smart Route, map, or existing booking behavior was changed by this component integration.

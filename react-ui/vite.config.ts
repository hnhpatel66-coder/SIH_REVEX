import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "."),
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "..") } },
  build: {
    outDir: path.resolve(__dirname, "../assets/react-ui"),
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, "src/loading-button-mount.tsx"),
      formats: ["iife"],
      name: "RevexLoadingButtons",
      fileName: () => "loading-buttons.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});

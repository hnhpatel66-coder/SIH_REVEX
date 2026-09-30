import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: [
    "../components/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  corePlugins: {
    preflight: false
  },
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;

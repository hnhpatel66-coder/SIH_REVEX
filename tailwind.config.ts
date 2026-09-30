import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;

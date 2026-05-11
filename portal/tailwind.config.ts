import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Gold palette — matches the Origin Monitor badge logo.
        forest: "#8a6818", // deep bronze (was forest green)
        grass: "#c49a46",  // primary gold (was grass green)
        light: "#e5c880",  // pale gold / cream (was light green)
        ink: "#0a0f0a",
        paper: "#ffffff",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      boxShadow: {
        glow: "0 0 40px -10px rgba(196,154,70,0.5)",
      },
    },
  },
  plugins: [],
} satisfies Config;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        mvp: {
          blue: "oklch(0.55 0.25 264)",
          "blue-light": "oklch(0.65 0.20 264)",
          "blue-dim": "oklch(0.40 0.15 264)",
        },
        surface: {
          0: "#0a0a0f",
          1: "#12121a",
          2: "#1a1a25",
          3: "#222230",
        },
        border: {
          DEFAULT: "#2a2a3a",
          light: "#3a3a4a",
        },
      },
    },
  },
  plugins: [],
};

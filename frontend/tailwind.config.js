/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        cockpit: {
          bg: "#0A0A0C",
          surface: "#0E0E11",
          card: "#111114",
          panel: "#141418",
          subtle: "#18181D",
          border: "#1C1C22",
          "border-subtle": "#222228",
          text: "#EDEDEF",
          "text-muted": "#8E8E93",
          "text-dim": "#52525B",
        },
        clinical: {
          gold: "#BFA054",
          "gold-dim": "#543C16",
          green: "#2BB673",
          "green-dim": "#153B25",
          red: "#D9465A",
          sky: "#38BDF8",
        },
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "Geist Mono", "Menlo", "Courier New", "monospace"],
      },
    },
  },
  plugins: [],
};

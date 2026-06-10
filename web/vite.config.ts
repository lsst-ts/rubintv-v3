import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api and /ws to the FastAPI backend so the SPA runs
// single-origin in development (no CORS). See Decision 7 / Phase 1. The
// backend port is overridable via RUBINTV_BACKEND_PORT so a second backend
// (e.g. one wired to a local Redis) can be targeted without editing config.
const BACKEND_PORT = process.env.RUBINTV_BACKEND_PORT ?? "8000";
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: `http://localhost:${BACKEND_PORT}`, changeOrigin: true },
      "/ws": {
        target: `ws://localhost:${BACKEND_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    // Always-on coverage reporting; no thresholds, so it never fails the run.
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test-setup.ts",
        "src/lib/api-types.ts",
      ],
    },
  },
});

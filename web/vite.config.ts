import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api and /ws to the FastAPI backend so the SPA runs
// single-origin in development (no CORS). See Decision 7 / Phase 1. The
// backend port is overridable via RUBINTV_BACKEND_PORT so a second backend
// (e.g. one wired to a local Redis) can be targeted without editing config.
const BACKEND_PORT = process.env.RUBINTV_BACKEND_PORT ?? "8000";
// The whole app is served under this prefix in every environment (the backend
// mounts its API/WS/SPA here too, matching the previous app's /rubintv root).
// Vite's base rewrites asset URLs and feeds import.meta.env.BASE_URL, which the
// router basename and the api/ws clients read, so this is the single source of
// truth for the prefix on the frontend.
const BASE = "/rubintv/";
export default defineConfig({
  base: BASE,
  plugins: [react()],
  server: {
    proxy: {
      // The prefixed paths the SPA now requests, forwarded to the backend
      // (which also serves them under the prefix).
      [`${BASE}api`]: {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
        // In deployment Gafaelfawr injects the authenticated user; locally
        // there is no auth proxy, so inject one here or the admin gate 403s
        // every write (local's admin_for is "*" = any authenticated user).
        headers: { "X-Auth-User": process.env.RUBINTV_DEV_USER ?? "localdev" },
      },
      [`${BASE}ws`]: {
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

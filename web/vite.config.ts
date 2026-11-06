import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api and /ws to the FastAPI backend so the SPA runs
// single-origin in development (no CORS). See Decision 7 / Phase 1. The
// backend port is overridable via RUBINTV_BACKEND_PORT so a second backend
// (e.g. one wired to a local Redis) can be targeted without editing config.
const BACKEND_PORT = process.env.RUBINTV_BACKEND_PORT ?? "8000";
// The prefix differs by deployment (RUBINTV_PATH_PREFIX: /rubintv, or
// /rubintv-dev on summit dev) and one image serves them all, so builds use a
// relative base. The backend points index.html's "./" URLs at its prefix as it
// serves the page and hands the SPA the prefix itself (spa.py,
// src/lib/deployment.ts). The dev server has no backend in front of
// index.html, so it serves at the default prefix, which also feeds
// import.meta.env.BASE_URL (the fallback in src/lib/basePath.ts).
const DEV_BASE = "/rubintv/";
export default defineConfig(({ command }) => ({
  base: command === "build" ? "./" : DEV_BASE,
  plugins: [react()],
  server: {
    proxy: {
      // The prefixed paths the SPA requests, forwarded to the backend (which
      // also serves them under the prefix).
      [`${DEV_BASE}api`]: {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
        // In deployment Gafaelfawr injects the authenticated user; locally
        // there is no auth proxy, so inject one here or the admin gate 403s
        // every write (local's admin_for is "*" = any authenticated user).
        headers: { "X-Auth-User": process.env.RUBINTV_DEV_USER ?? "localdev" },
        // Pass a backend abort on. When the S3 proxy can't finish an object
        // it closes the connection mid-body (so the browser never keeps a
        // short file as whole), but the dev proxy would leave the browser's
        // connection open, waiting forever. Closing it too gives the browser
        // the same failed transfer it gets in deployment.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            proxyRes.on("close", () => {
              if (!proxyRes.complete) res.destroy();
            });
          });
        },
      },
      [`${DEV_BASE}ws`]: {
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
    // Always-on coverage reporting. The thresholds are passed in CI only
    // (.github/workflows/ci.yml), so partial local runs never fail on them.
    coverage: {
      enabled: true,
      provider: "v8",
      // json-summary feeds the CI job summary (scripts/coverage-summary.mjs).
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test-setup.ts",
        "src/lib/api-types.ts",
      ],
    },
  },
}));

import { DEPLOYMENT } from "./deployment";

// The app's path prefix (e.g. "/rubintv") without a trailing slash, so it
// concatenates cleanly with absolute paths: `${BASE}/api/...`, `${BASE}/ws`.
//
// Client-side <Link>/navigation URLs go through the router basename and must
// NOT include this — react-router adds it. But `fetch()` and `new WebSocket()`
// take absolute same-origin paths that bypass the router, so those call sites
// prepend BASE explicitly. This is the single source of truth for that. The
// value comes from the backend (RUBINTV_PATH_PREFIX, written into index.html)
// when it serves the built SPA, else from Vite's dev-server `base`.
export const BASE =
  DEPLOYMENT.prefix ?? import.meta.env.BASE_URL.replace(/\/$/, "");

// URL for a camera/location logo image, bundled with the SPA under
// `public/logos/` and served at `${BASE}/logos/<file>`. The `logo` config value
// is a bare filename (e.g. "Summit.jpg"); returns null when a config entry has
// no logo so callers can fall back to a plain (photoless) button.
export const logoUrl = (logo: string | null | undefined): string | null =>
  logo ? `${BASE}/logos/${logo}` : null;

// The app's path prefix (Vite `base`, e.g. "/rubintv/") without its trailing
// slash, so it concatenates cleanly with absolute paths: `${BASE}/api/...`,
// `${BASE}/ws`.
//
// Client-side <Link>/navigation URLs go through the router basename and must
// NOT include this — react-router adds it. But `fetch()` and `new WebSocket()`
// take absolute same-origin paths that bypass both the router and Vite's base
// rewriting, so those call sites prepend BASE explicitly. This is the single
// source of truth for that; the value ultimately comes from Vite's `base`.
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// URL for a camera/location logo image, bundled with the SPA under
// `public/logos/` and served at `${BASE}/logos/<file>`. The `logo` config value
// is a bare filename (e.g. "Summit.jpg"); returns null when a config entry has
// no logo so callers can fall back to a plain (photoless) button.
export const logoUrl = (logo: string | null | undefined): string | null =>
  logo ? `${BASE}/logos/${logo}` : null;

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

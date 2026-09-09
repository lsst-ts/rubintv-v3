// Fill the Python-style format templates used by per-row links in the camera
// table: image_viewer_link, quicklook_viewer_link, and copy_row_template.
//
// Templates carry placeholders the old app resolved client-side:
//   {dayObs}                  the date as an 8-digit YYYYMMDD integer
//   {seqNum:0N}               the seq, zero-padded to N digits
//   {controller[:default=X]}  the row's "controller" metadata value, else X
//   {siteLoc}                 the deployment site's domain (summit→cp, base→ls)
//   {dev}                     "-dev" on a dev/local instance, else ""
// Per-row values (dayObs, seqNum, controller) vary by row; the site/dev ones
// are fixed for the running instance. Unknown site locations and the absent
// {dev} both resolve to "" — matching the original, which left those URLs
// best-effort rather than dropping the link.

export interface LinkContext {
  siteLocation?: string;
  controller?: string;
  isDevInstance?: boolean;
}

// summit/base are the only sites the original mapped to a domain; anything
// else (incl. the *-usdf and test locations) yields "".
const SITE_LOC_TO_DOMAIN: Record<string, string> = {
  summit: "cp",
  base: "ls",
};

function padSeq(spec: string, seqNum: string): string {
  // spec is "{seqNum:0N}"; pull N and left-pad with zeros.
  const m = spec.match(/:0?(\d+)/);
  const width = m ? Number(m[1]) : 0;
  return seqNum.padStart(width, "0");
}

export function fillTemplate(
  template: string,
  date: string,
  seqNum: number | string,
  { siteLocation = "", controller = "", isDevInstance = false }: LinkContext = {},
): string {
  const dayObs = String(date).replace(/-/g, "");
  const seq = String(seqNum);
  return template
    .replace(/\{dev\}/g, isDevInstance ? "-dev" : "")
    .replace(/\{siteLoc\}/g, SITE_LOC_TO_DOMAIN[siteLocation] ?? "")
    .replace(
      /\{controller(?::default=(\w+))?\}/g,
      (_m, def) => controller || def || "",
    )
    .replace(/\{dayObs\}/g, dayObs)
    .replace(/\{seqNum:0?\d+\}/g, (m) => padSeq(m, seq));
}

// A dev instance is the local dev server or any "-dev" deployment — matches
// the original window.location heuristic.
export function isDevInstance(): boolean {
  const href = typeof window !== "undefined" ? window.location.href : "";
  return href.includes("-dev") || href.includes("localhost");
}

// The environment the header's warning strip calls out. Non-prod shapes are
// distinguished so the strip can label what it is:
//   localhost — the local dev server
//   dev       — a deployed "-dev" instance
//   ci        — the GitHub-Actions site ("gha")
//   test      — the integration-test site
//   prod      — a real deployment; no strip
export type InstanceEnv = "localhost" | "dev" | "ci" | "test" | "prod";

// Backend sites (RAPID_ANALYSIS_LOCATION) that are not production. Native prod sites
// (summit, usdf-k8s, base, tucson) are absent, so they map to "prod".
const NON_PROD_SITES: Record<string, InstanceEnv> = {
  local: "localhost",
  gha: "ci",
  test: "test",
};

// Resolve the environment from BOTH the backend site and the hostname: the
// strip shows if EITHER says non-prod. The backend site is authoritative for
// the deployment shape (local/gha/test); the hostname still catches a deployed
// "-dev" instance (a prod-shaped site served from a *-dev host) that the site
// name alone wouldn't flag. `site` is undefined until /api/config resolves.
export function instanceEnv(site?: string): InstanceEnv {
  if (site && site in NON_PROD_SITES) return NON_PROD_SITES[site];
  const href = typeof window !== "undefined" ? window.location.href : "";
  if (href.includes("localhost")) return "localhost";
  if (href.includes("-dev")) return "dev";
  return "prod";
}

// The processing-mode banner shown in the header on the LSSTCam cameras
// (lsstcam / lsstcam_aos). Text is driven by the deployment site: the USDF
// location runs nightly validation; the summit runs live quicklook. Any other
// location — or any other camera — gets no banner (returns null).
const PROCESSING_BANNER_CAMERAS = new Set(["lsstcam", "lsstcam_aos"]);

const SITE_TO_PROCESSING_BANNER: Record<string, string> = {
  usdf: "USDF Nightly Validation Processing",
  summit: "Summit Quicklook Processing",
  "summit-usdf": "Summit Quicklook Processing",
};

export function processingBanner(
  location: string,
  camera: string,
): string | null {
  if (!PROCESSING_BANNER_CAMERAS.has(camera)) return null;
  return SITE_TO_PROCESSING_BANNER[location] ?? null;
}

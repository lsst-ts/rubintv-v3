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

// A "_<col>" metadata value names CSS class(es) for the "<col>" cell — the old
// app's per-cell colour-indicator convention. We namespace each token under
// `cell-` to isolate it from app styles, and sanitise to a safe class token.
// Multiple space-separated tokens are honoured. Returns "" when absent/empty.
//
// Shared by the camera table (CameraDataTable) and the single-channel view
// (Channel) so both colour cells from the same `_`-prefixed indicators.
export function cellFlagClass(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  if (!s) return "";
  return s
    .split(/\s+/)
    .map((t) => "cell-" + t.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"))
    .join(" ");
}

// Truncate float-like metadata to 3dp for display, keeping the full value for a
// hover tooltip. Shared by the camera table and the single-channel view's
// metadata panel so a value reads the same in both. Integers and non-numeric values pass through unchanged — only
// a value with a fractional part is truncated (a whole number like 5 must not
// render as "5.000", which the old unconditional toFixed(3) produced for every
// JSON number).
export function formatCell(value: unknown): { display: string; title?: string } {
  if (value === null || value === undefined || value === "")
    return { display: "—" };
  const s = String(value);
  if (typeof value === "number" || /^-?\d*\.\d+$/.test(s)) {
    const n = Number(value);
    if (!Number.isNaN(n) && !Number.isInteger(n)) {
      const trunc = (Math.trunc(n * 1000) / 1000).toFixed(3);
      return trunc === s ? { display: s } : { display: trunc, title: s };
    }
  }
  return { display: s };
}

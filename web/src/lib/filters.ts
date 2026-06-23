// Metadata table filters. A filter narrows the visible rows by a column's
// value. Ported from the design's filter model (design/from-claude/Camera
// Table - Sidebar v2.html): each filter is {col, op, value}; the column's type
// (inferred from the real metadata, which carries no schema) decides which
// operators apply, and matchRow is the per-row predicate.

import type { Metadata } from "./types";

export type FilterType = "number" | "string";

export interface Filter {
  col: string;
  op: string;
  value: string;
}

// Operators per inferred column type. [op, label].
export const OPS_BY_TYPE: Record<FilterType, [string, string][]> = {
  number: [
    ["=", "="],
    ["!=", "≠"],
    [">", ">"],
    ["<", "<"],
    [">=", "≥"],
    ["<=", "≤"],
    ["between", "between"],
  ],
  string: [
    ["=", "equals"],
    ["!=", "not equals"],
    ["~", "contains"],
    ["starts", "starts with"],
    ["ends", "ends with"],
    ["in", "is one of"],
  ],
};

export function opLabel(type: FilterType, op: string): string {
  return OPS_BY_TYPE[type].find(([o]) => o === op)?.[1] ?? op;
}

const numeric = /^-?\d*\.?\d+$/;

// Infer a column's type from its values across the metadata. Numeric if every
// present value parses as a number; otherwise string. Empty / all-missing
// columns default to string.
export function inferType(metadata: Metadata, col: string): FilterType {
  if (col === SEQ_COL) return "number";
  let sawValue = false;
  for (const row of Object.values(metadata)) {
    const v = row[col];
    if (v === null || v === undefined || v === "" || v === "—") continue;
    sawValue = true;
    if (!numeric.test(String(v).trim())) return "string";
  }
  return sawValue ? "number" : "string";
}

// Does a single cell value satisfy one filter clause?
function matchOne(cellVal: unknown, op: string, value: string): boolean {
  const s = String(cellVal ?? "");
  const target = value.trim();
  const sl = s.toLowerCase();
  const tl = target.toLowerCase();
  switch (op) {
    case "=":
      return sl === tl;
    case "!=":
      return sl !== tl;
    case "~":
      return sl.includes(tl);
    case "starts":
      return sl.startsWith(tl);
    case "ends":
      return sl.endsWith(tl);
    case "in":
      return target
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
        .includes(sl);
    case "between": {
      const [lo, hi] = target.split(/\s*[,–-]\s*/).map(parseFloat);
      const a = parseFloat(s);
      if ([a, lo, hi].some(Number.isNaN)) return false;
      return a >= Math.min(lo, hi) && a <= Math.max(lo, hi);
    }
    case ">":
    case "<":
    case ">=":
    case "<=": {
      const a = parseFloat(s);
      const b = parseFloat(target);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (op === ">") return a > b;
      if (op === "<") return a < b;
      if (op === ">=") return a >= b;
      return a <= b;
    }
    default:
      return true;
  }
}

// The synthetic "column" for filtering on the row's sequence number. It isn't a
// metadata field — its value is the row's seq itself — so matchRow handles it
// specially and the UI exposes it as a numeric column named "Seq.No".
export const SEQ_COL = "Seq.No";

// Does a row satisfy every active filter? `seq` is the row's sequence number,
// so a filter on SEQ_COL matches against it rather than a metadata field.
export function matchRow(
  seq: number,
  row: Record<string, unknown> | undefined,
  filters: Filter[],
): boolean {
  if (filters.length === 0) return true;
  const r = row ?? {};
  return filters.every((f) =>
    matchOne(f.col === SEQ_COL ? seq : r[f.col], f.op, f.value),
  );
}

// The URL params that describe a Seq.No filter. A range (seqMin/seqMax) and a
// single value (seqNum) are mutually exclusive; when both are present the range
// wins. Only these forms are URL-representable — other Seq.No operators (>, <,
// between, …) live in app state but aren't reflected in the URL.
export interface SeqParams {
  seqMin: string | null;
  seqMax: string | null;
  seqNum: string | null;
}

const trimmed = (v: string | null) => (v && v.trim() ? v.trim() : null);

// Build the Seq.No filter clauses described by the URL params. A range
// (seqMin → "Seq.No >= min", seqMax → "Seq.No <= max") takes precedence; only
// if neither bound is present does a lone seqNum become "Seq.No = num".
export function seqParamsToFilters({ seqMin, seqMax, seqNum }: SeqParams): Filter[] {
  const lo = trimmed(seqMin);
  const hi = trimmed(seqMax);
  const out: Filter[] = [];
  if (lo) out.push({ col: SEQ_COL, op: ">=", value: lo });
  if (hi) out.push({ col: SEQ_COL, op: "<=", value: hi });
  if (out.length) return out;
  const n = trimmed(seqNum);
  return n ? [{ col: SEQ_COL, op: "=", value: n }] : [];
}

// Back-compat shim for the range-only callers/tests.
export function seqRangeFilters(seqMin: string | null, seqMax: string | null): Filter[] {
  return seqParamsToFilters({ seqMin, seqMax, seqNum: null });
}

// Extract the URL-representable Seq.No params from a filter list, for syncing
// back to the URL. A >=/<= range takes precedence and clears seqNum; otherwise
// a single "Seq.No =" clause becomes seqNum. Mutually exclusive by construction.
export function filtersToSeqParams(filters: Filter[]): SeqParams {
  let seqMin: string | null = null;
  let seqMax: string | null = null;
  let seqNum: string | null = null;
  for (const f of filters) {
    if (f.col !== SEQ_COL) continue;
    if (f.op === ">=") seqMin = f.value;
    else if (f.op === "<=") seqMax = f.value;
    else if (f.op === "=") seqNum = f.value;
  }
  if (seqMin || seqMax) return { seqMin, seqMax, seqNum: null };
  return { seqMin: null, seqMax: null, seqNum };
}

// Up to `limit` distinct non-empty sample values for a column, for the
// add-filter popover's "common values" suggestions.
export function sampleValues(
  metadata: Metadata,
  col: string,
  limit = 8,
): string[] {
  const seen = new Set<string>();
  for (const row of Object.values(metadata)) {
    const v = row[col];
    if (v === null || v === undefined || v === "" || v === "—") continue;
    seen.add(String(v));
    if (seen.size >= limit) break;
  }
  return [...seen];
}

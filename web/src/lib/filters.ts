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

// Does a row (the metadata for one seq) satisfy every active filter?
export function matchRow(
  row: Record<string, unknown> | undefined,
  filters: Filter[],
): boolean {
  if (filters.length === 0) return true;
  const r = row ?? {};
  return filters.every((f) => matchOne(r[f.col], f.op, f.value));
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

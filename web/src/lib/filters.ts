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

// The Seq.No filter is shareable via a single catch-all URL param, ?seq_filter,
// that encodes every operator (not just the range) — but is scoped to Seq.No so
// it doesn't imply arbitrary columns are URL-passable. The grammar uses only
// URL-unreserved characters (letters, digits, "-", "_") so it stays readable in
// the address bar without percent-encoding. Clauses are "-"-joined; each is a
// spelled operator token glued to its value:
//   gte770-lte786   (a range)    42         (bare value ⇒ eq)
//   gt500           ne99         lt1000
//   between770_786               in10_20_30
// "between" / "in" carry compound values with "_" as their inner separator.

// Spelled operator tokens ⇄ the Filter ops they map to. Order matters: longest
// token first so "gte" matches before "gt".
const SEQ_OP_TOKENS: [string, string][] = [
  ["gte", ">="],
  ["lte", "<="],
  ["gt", ">"],
  ["lt", "<"],
  ["ne", "!="],
  ["eq", "="],
];
const SEQ_TOKEN_FOR_OP: Record<string, string> = Object.fromEntries(
  SEQ_OP_TOKENS.map(([tok, op]) => [op, tok]),
);

// Parse one "seq_filter" clause into a Seq.No filter, or null if unparseable.
function parseSeqClause(raw: string): Filter | null {
  const s = raw.trim();
  if (!s) return null;
  for (const named of ["between", "in"] as const) {
    if (s.toLowerCase().startsWith(named)) {
      // Compound values use "_" internally → matchOne wants ", ".
      const v = s.slice(named.length).trim().replace(/_/g, ", ");
      return v ? { col: SEQ_COL, op: named, value: v } : null;
    }
  }
  for (const [tok, op] of SEQ_OP_TOKENS) {
    if (s.toLowerCase().startsWith(tok)) {
      const value = s.slice(tok.length).trim();
      return value ? { col: SEQ_COL, op, value } : null;
    }
  }
  // No operator token ⇒ a bare value defaults to equality.
  return { col: SEQ_COL, op: "=", value: s };
}

// Build the Seq.No filter clauses described by ?seq_filter (may be null/empty).
export function seqFilterToFilters(seqFilter: string | null): Filter[] {
  if (!seqFilter || !seqFilter.trim()) return [];
  return seqFilter
    .split("-")
    .map(parseSeqClause)
    .filter((f): f is Filter => f !== null);
}

// Serialize the Seq.No clauses of a filter list back into a ?seq_filter value
// (the inverse of seqFilterToFilters), or null when there are none.
export function filtersToSeqFilter(filters: Filter[]): string | null {
  const join = (v: string) =>
    v.split(",").map((x) => x.trim()).filter(Boolean).join("_");
  const clauses: string[] = [];
  for (const f of filters) {
    if (f.col !== SEQ_COL) continue;
    if (f.op === "between" || f.op === "in") clauses.push(`${f.op}${join(f.value)}`);
    else if (f.op === "=") clauses.push(f.value);
    else clauses.push(`${SEQ_TOKEN_FOR_OP[f.op] ?? f.op}${f.value}`);
  }
  return clauses.length ? clauses.join("-") : null;
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

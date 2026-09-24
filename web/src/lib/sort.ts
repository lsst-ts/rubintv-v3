// Column sorting for the camera table. Any orderable column (the synthetic
// Seq.No or a metadata column) can be sorted ascending or descending; the
// default — no explicit sort — is Seq.No descending (newest exposure first),
// matching the table's historical ordering.
//
// Sorting reuses the filter module's type inference: a column whose values all
// parse as numbers sorts numerically, otherwise case-insensitively as strings.
// Rows whose cell is empty/missing always sink to the bottom regardless of
// direction, so a sort never buries populated rows under blanks.

import type { Metadata } from "./types";
import { inferType, SEQ_COL } from "./filters";

export type SortDir = "asc" | "desc";

export interface SortState {
  col: string; // a metadata column name, or SEQ_COL for the seq number
  dir: SortDir;
}

// Is this column orderable? Channel chips and per-row action columns aren't —
// only the seq number and metadata columns carry comparable values.
export function isSortableKey(key: string): boolean {
  return key === "seq" || key.startsWith("meta:");
}

// The SortState column for a column model key ("seq" → SEQ_COL, "meta:Foo" →
// "Foo"), or null when the key isn't sortable.
export function sortColForKey(key: string): string | null {
  if (key === "seq") return SEQ_COL;
  if (key.startsWith("meta:")) return key.slice(5);
  return null;
}

// Treat empty/missing cells as absent so they sort to the bottom.
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "" || v === "—";
}

// Return seqNums ordered by `sort`. The default (sort == null, or Seq.No desc)
// is the caller's existing newest-first order, so callers can keep passing the
// already-descending list unchanged in that case. Stable: ties (and blanks)
// retain the input order. Does not mutate the input.
export function sortSeqNums(
  seqNums: number[],
  metadata: Metadata,
  sort: SortState | null,
): number[] {
  if (!sort) return seqNums;

  const sign = sort.dir === "asc" ? 1 : -1;

  if (sort.col === SEQ_COL) {
    // Seq numbers are always numeric; no blank handling needed.
    return [...seqNums].sort((a, b) => sign * (a - b));
  }

  const numeric = inferType(metadata, sort.col) === "number";
  const cell = (seq: number) => metadata[String(seq)]?.[sort.col];

  // Decorate-sort-undecorate keeps the comparator cheap and the sort stable
  // (the index tiebreaker preserves input order for equal keys and blanks).
  return seqNums
    .map((seq, i) => ({ seq, i, v: cell(seq) }))
    .sort((a, b) => {
      const aBlank = isBlank(a.v);
      const bBlank = isBlank(b.v);
      if (aBlank || bBlank) {
        if (aBlank && bBlank) return a.i - b.i; // both blank: keep order
        return aBlank ? 1 : -1; // blanks always last
      }
      let cmp: number;
      if (numeric) {
        cmp = parseFloat(String(a.v)) - parseFloat(String(b.v));
      } else {
        cmp = String(a.v).localeCompare(String(b.v), undefined, {
          sensitivity: "base",
          numeric: true,
        });
      }
      return cmp !== 0 ? sign * cmp : a.i - b.i;
    })
    .map((d) => d.seq);
}

// The next sort state when a column header is clicked. Cycles
// desc → asc → none (back to default Seq.No desc) for the active column;
// clicking a different column starts it at descending. Returning null means
// "no explicit sort" (the default order).
export function nextSort(
  current: SortState | null,
  col: string,
): SortState | null {
  if (!current || current.col !== col) return { col, dir: "desc" };
  if (current.dir === "desc") return { col, dir: "asc" };
  return null;
}

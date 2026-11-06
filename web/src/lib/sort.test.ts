import { describe, it, expect } from "vitest";
import {
  sortSeqNums,
  nextSort,
  isSortableKey,
  sortColForKey,
  type SortState,
} from "./sort";
import { SEQ_COL } from "./filters";
import type { Metadata } from "./types";

const meta: Metadata = {
  "10": { exptime: "30", filter: "g", note: "alpha" },
  "11": { exptime: "5", filter: "r", note: "" },
  "12": { exptime: "30.5", filter: "i" }, // no note
  "13": { exptime: "—", filter: "g", note: "beta" }, // blank exptime
};

describe("isSortableKey / sortColForKey", () => {
  it("recognises seq and metadata columns as sortable", () => {
    expect(isSortableKey("seq")).toBe(true);
    expect(isSortableKey("meta:exptime")).toBe(true);
    expect(isSortableKey("ch:HSC")).toBe(false);
    expect(isSortableKey("viewer")).toBe(false);
  });
  it("maps column keys to sort columns", () => {
    expect(sortColForKey("seq")).toBe(SEQ_COL);
    expect(sortColForKey("meta:exptime")).toBe("exptime");
    expect(sortColForKey("ch:HSC")).toBeNull();
  });
});

describe("sortSeqNums", () => {
  const seqs = [13, 12, 11, 10];

  it("returns the input unchanged when sort is null (default order)", () => {
    expect(sortSeqNums(seqs, meta, null)).toEqual(seqs);
  });

  it("sorts the seq column numerically in both directions", () => {
    expect(sortSeqNums(seqs, meta, { col: SEQ_COL, dir: "asc" })).toEqual([
      10, 11, 12, 13,
    ]);
    expect(sortSeqNums(seqs, meta, { col: SEQ_COL, dir: "desc" })).toEqual([
      13, 12, 11, 10,
    ]);
  });

  it("sorts a numeric metadata column numerically (not lexically)", () => {
    // exptime: 10→30, 11→5, 12→30.5, 13→blank. Blank sinks last in both dirs.
    expect(sortSeqNums(seqs, meta, { col: "exptime", dir: "asc" })).toEqual([
      11, 10, 12, 13,
    ]);
    expect(sortSeqNums(seqs, meta, { col: "exptime", dir: "desc" })).toEqual([
      12, 10, 11, 13,
    ]);
  });

  it("sorts a string column case-insensitively, blanks last", () => {
    // note: 10→alpha, 11→"", 12→missing, 13→beta. Blanks (11,12) keep their
    // input order, which is 12 before 11.
    expect(sortSeqNums(seqs, meta, { col: "note", dir: "asc" })).toEqual([
      10, 13, 12, 11,
    ]);
    expect(sortSeqNums(seqs, meta, { col: "note", dir: "desc" })).toEqual([
      13, 10, 12, 11,
    ]);
  });

  it("is stable for ties (equal keys keep input order)", () => {
    // filter g appears for 10 and 13; input order is 13 before 10.
    const byFilter = sortSeqNums(seqs, meta, { col: "filter", dir: "asc" });
    expect(byFilter.indexOf(13)).toBeLessThan(byFilter.indexOf(10));
  });

  it("does not mutate the input array", () => {
    const input = [13, 12, 11, 10];
    sortSeqNums(input, meta, { col: SEQ_COL, dir: "asc" });
    expect(input).toEqual([13, 12, 11, 10]);
  });
});

describe("nextSort", () => {
  it("starts a fresh column at descending", () => {
    expect(nextSort(null, "exptime")).toEqual({ col: "exptime", dir: "desc" });
    expect(nextSort({ col: "filter", dir: "asc" }, "exptime")).toEqual({
      col: "exptime",
      dir: "desc",
    });
  });
  it("cycles desc → asc → off for the active column", () => {
    const desc: SortState = { col: "exptime", dir: "desc" };
    const asc = nextSort(desc, "exptime");
    expect(asc).toEqual({ col: "exptime", dir: "asc" });
    expect(nextSort(asc, "exptime")).toBeNull();
  });
});

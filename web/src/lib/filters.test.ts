import {
  SEQ_COL,
  filtersToSeqRange,
  inferType,
  matchRow,
  opLabel,
  sampleValues,
  seqRangeFilters,
} from "./filters";
import type { Metadata } from "./types";

const meta: Metadata = {
  "1": { exp: "30", filter: "z_20", target: "lowdust" },
  "2": { exp: "15", filter: "r_03", target: "—" },
  "3": { exp: "45", filter: "z_20" },
};

test("inferType: numeric column vs string column", () => {
  expect(inferType(meta, "exp")).toBe("number");
  expect(inferType(meta, "filter")).toBe("string");
  // A column with no present values defaults to string.
  expect(inferType(meta, "missing")).toBe("string");
});

test("matchRow: empty filters match everything", () => {
  expect(matchRow(0, meta["1"], [])).toBe(true);
  expect(matchRow(0, undefined, [])).toBe(true);
});

test("matchRow: string operators", () => {
  expect(matchRow(0, meta["1"], [{ col: "filter", op: "=", value: "z_20" }])).toBe(true);
  expect(matchRow(0, meta["2"], [{ col: "filter", op: "=", value: "z_20" }])).toBe(false);
  expect(matchRow(0, meta["1"], [{ col: "filter", op: "~", value: "20" }])).toBe(true);
  expect(matchRow(0, meta["1"], [{ col: "target", op: "starts", value: "low" }])).toBe(true);
  expect(
    matchRow(0, meta["1"], [{ col: "filter", op: "in", value: "r_03, z_20" }]),
  ).toBe(true);
});

test("matchRow: number operators incl. between", () => {
  expect(matchRow(0, meta["1"], [{ col: "exp", op: ">", value: "20" }])).toBe(true);
  expect(matchRow(0, meta["2"], [{ col: "exp", op: ">", value: "20" }])).toBe(false);
  expect(
    matchRow(0, meta["1"], [{ col: "exp", op: "between", value: "25, 40" }]),
  ).toBe(true);
  expect(
    matchRow(0, meta["3"], [{ col: "exp", op: "between", value: "25, 40" }]),
  ).toBe(false);
});

test("matchRow: every filter must match (AND)", () => {
  const f = [
    { col: "filter", op: "=", value: "z_20" },
    { col: "exp", op: ">", value: "20" },
  ];
  expect(matchRow(0, meta["1"], f)).toBe(true); // z_20 & 30>20
  expect(matchRow(0, meta["3"], f)).toBe(true); // z_20 & 45>20
  expect(matchRow(0, meta["2"], f)).toBe(false); // r_03
});

test("sampleValues: distinct non-empty values", () => {
  expect(sampleValues(meta, "filter")).toEqual(["z_20", "r_03"]);
  // The em-dash sentinel is skipped.
  expect(sampleValues(meta, "target")).toEqual(["lowdust"]);
});

test("opLabel maps op to its human label per type", () => {
  expect(opLabel("string", "~")).toBe("contains");
  expect(opLabel("number", ">=")).toBe("≥");
});

test("matchRow: a SEQ_COL filter matches the row's seq, not metadata", () => {
  const f = [{ col: SEQ_COL, op: ">=", value: "770" }];
  expect(matchRow(786, meta["1"], f)).toBe(true);
  expect(matchRow(760, meta["1"], f)).toBe(false);
  // Seq.No is treated as numeric.
  expect(inferType(meta, SEQ_COL)).toBe("number");
});

test("seqRangeFilters builds >= / <= clauses (open ends allowed)", () => {
  expect(seqRangeFilters("770", "786")).toEqual([
    { col: SEQ_COL, op: ">=", value: "770" },
    { col: SEQ_COL, op: "<=", value: "786" },
  ]);
  expect(seqRangeFilters("770", null)).toEqual([
    { col: SEQ_COL, op: ">=", value: "770" },
  ]);
  expect(seqRangeFilters(null, null)).toEqual([]);
});

test("filtersToSeqRange round-trips the range out of a filter list", () => {
  const filters = [
    { col: "filter", op: "=", value: "z_20" },
    { col: SEQ_COL, op: ">=", value: "770" },
    { col: SEQ_COL, op: "<=", value: "786" },
  ];
  expect(filtersToSeqRange(filters)).toEqual({ seqMin: "770", seqMax: "786" });
  expect(filtersToSeqRange([{ col: "filter", op: "=", value: "x" }])).toEqual({
    seqMin: null,
    seqMax: null,
  });
});

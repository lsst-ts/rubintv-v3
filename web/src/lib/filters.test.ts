import {
  SEQ_COL,
  filtersToSeqFilter,
  inferType,
  matchRow,
  opLabel,
  sampleValues,
  seqFilterToFilters,
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

test("seqFilterToFilters parses every operator form", () => {
  // A range is two clauses.
  expect(seqFilterToFilters(">=770,<=786")).toEqual([
    { col: SEQ_COL, op: ">=", value: "770" },
    { col: SEQ_COL, op: "<=", value: "786" },
  ]);
  // A bare value defaults to equality.
  expect(seqFilterToFilters("42")).toEqual([{ col: SEQ_COL, op: "=", value: "42" }]);
  // Single-char and not-equal operators.
  expect(seqFilterToFilters(">500")).toEqual([{ col: SEQ_COL, op: ">", value: "500" }]);
  expect(seqFilterToFilters("!=99")).toEqual([{ col: SEQ_COL, op: "!=", value: "99" }]);
  // between uses lo-hi; in uses ";"-separated values (normalised for matchOne).
  expect(seqFilterToFilters("between:770-786")).toEqual([
    { col: SEQ_COL, op: "between", value: "770-786" },
  ]);
  expect(seqFilterToFilters("in:10;20;30")).toEqual([
    { col: SEQ_COL, op: "in", value: "10, 20, 30" },
  ]);
  // Empty / whitespace yields no clauses.
  expect(seqFilterToFilters(null)).toEqual([]);
  expect(seqFilterToFilters("  ")).toEqual([]);
});

test("filtersToSeqFilter serialises Seq.No clauses, ignoring other columns", () => {
  expect(
    filtersToSeqFilter([
      { col: "filter", op: "=", value: "z_20" },
      { col: SEQ_COL, op: ">=", value: "770" },
      { col: SEQ_COL, op: "<=", value: "786" },
    ]),
  ).toBe(">=770,<=786");
  expect(filtersToSeqFilter([{ col: SEQ_COL, op: "=", value: "42" }])).toBe("42");
  expect(filtersToSeqFilter([{ col: SEQ_COL, op: ">", value: "5" }])).toBe(">5");
  expect(filtersToSeqFilter([{ col: SEQ_COL, op: "between", value: "770, 786" }])).toBe(
    "between:770-786",
  );
  expect(filtersToSeqFilter([{ col: SEQ_COL, op: "in", value: "10, 20, 30" }])).toBe(
    "in:10;20;30",
  );
  // No Seq.No clauses → null.
  expect(filtersToSeqFilter([{ col: "filter", op: "=", value: "x" }])).toBeNull();
});

test("seq_filter round-trips through filters and back", () => {
  for (const sf of [">=770,<=786", "42", ">500", "!=99", "between:770-786", "in:10;20;30"]) {
    expect(filtersToSeqFilter(seqFilterToFilters(sf))).toBe(sf);
  }
});

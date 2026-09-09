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

test("matchRow: numeric = / != compare by value, not string", () => {
  // Regression: "= 30" must match a cell of "30.0" (string equality missed it).
  const m: Metadata = { "1": { exp: "30.0" }, "2": { exp: "31" } };
  expect(matchRow(0, m["1"], [{ col: "exp", op: "=", value: "30" }])).toBe(true);
  expect(matchRow(0, m["2"], [{ col: "exp", op: "=", value: "30" }])).toBe(false);
  // != is the negation, so the "30.0" row is excluded by "!= 30".
  expect(matchRow(0, m["1"], [{ col: "exp", op: "!=", value: "30" }])).toBe(false);
  expect(matchRow(0, m["2"], [{ col: "exp", op: "!=", value: "30" }])).toBe(true);
  // Non-numeric values still compare as strings, case-insensitively.
  expect(matchRow(0, { c: "Abc" }, [{ col: "c", op: "=", value: "abc" }])).toBe(true);
});

test("matchRow: between with negative bounds", () => {
  // Regression: "-5, 10" split on "-" to NaN and matched nothing.
  const f = (v: string) => [{ col: "t", op: "between", value: v }];
  expect(matchRow(0, { t: "3" }, f("-5, 10"))).toBe(true);
  expect(matchRow(0, { t: "-2" }, f("-5, 10"))).toBe(true);
  expect(matchRow(0, { t: "-9" }, f("-5, 10"))).toBe(false);
  // Separator variants still work: bare hyphen, spaced hyphen, en-dash.
  expect(matchRow(0, { t: "5" }, f("1-10"))).toBe(true);
  expect(matchRow(0, { t: "5" }, f("1 - 10"))).toBe(true);
  expect(matchRow(0, { t: "5" }, f("1–10"))).toBe(true);
  // Two negatives separated by a spaced hyphen.
  expect(matchRow(0, { t: "-7" }, f("-10 - -5"))).toBe(true);
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

test("seqFilterToFilters parses every spelled-token operator form", () => {
  // A range is two clauses joined by "-".
  expect(seqFilterToFilters("gte770-lte786")).toEqual([
    { col: SEQ_COL, op: ">=", value: "770" },
    { col: SEQ_COL, op: "<=", value: "786" },
  ]);
  // A bare value defaults to equality (so does the explicit eq token).
  expect(seqFilterToFilters("42")).toEqual([{ col: SEQ_COL, op: "=", value: "42" }]);
  expect(seqFilterToFilters("eq42")).toEqual([{ col: SEQ_COL, op: "=", value: "42" }]);
  // gt is matched, not gte (longest-token-first).
  expect(seqFilterToFilters("gt500")).toEqual([{ col: SEQ_COL, op: ">", value: "500" }]);
  expect(seqFilterToFilters("ne99")).toEqual([{ col: SEQ_COL, op: "!=", value: "99" }]);
  // between/in use "_" internally (normalised to ", " for matchOne).
  expect(seqFilterToFilters("between770_786")).toEqual([
    { col: SEQ_COL, op: "between", value: "770, 786" },
  ]);
  expect(seqFilterToFilters("in10_20_30")).toEqual([
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
  ).toBe("gte770-lte786");
  expect(filtersToSeqFilter([{ col: SEQ_COL, op: "=", value: "42" }])).toBe("42");
  expect(filtersToSeqFilter([{ col: SEQ_COL, op: ">", value: "5" }])).toBe("gt5");
  expect(filtersToSeqFilter([{ col: SEQ_COL, op: "between", value: "770, 786" }])).toBe(
    "between770_786",
  );
  expect(filtersToSeqFilter([{ col: SEQ_COL, op: "in", value: "10, 20, 30" }])).toBe(
    "in10_20_30",
  );
  // No Seq.No clauses → null.
  expect(filtersToSeqFilter([{ col: "filter", op: "=", value: "x" }])).toBeNull();
});

test("seq_filter round-trips through filters and back, with no percent-encoding", () => {
  for (const sf of ["gte770-lte786", "42", "gt500", "ne99", "between770_786", "in10_20_30"]) {
    expect(filtersToSeqFilter(seqFilterToFilters(sf))).toBe(sf);
    // The serialised form survives URLSearchParams untouched (URL-readable).
    const p = new URLSearchParams();
    p.set("seq_filter", sf);
    expect(p.toString()).toBe(`seq_filter=${sf}`);
  }
});

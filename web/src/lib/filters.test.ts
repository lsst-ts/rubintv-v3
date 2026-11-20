import {
  SEQ_COL,
  filtersToSeqFilter,
  inferType,
  isFilterable,
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

test("isFilterable: object and array columns are excluded", () => {
  const m = {
    "1": { exp: "30", hdr: { a: 1 }, tags: null },
    "2": { exp: "15", tags: ["x"] },
  } as unknown as Metadata;
  expect(isFilterable(m, "exp")).toBe(true);
  expect(isFilterable(m, "hdr")).toBe(false);
  expect(isFilterable(m, "tags")).toBe(false);
  expect(isFilterable(m, "missing")).toBe(true);
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

test("matchRow: the remaining comparison and text operators", () => {
  const r = { exp: "30", name: "HD 1234" };
  const m = (op: string, value: string, col = "exp") =>
    matchRow(0, r, [{ col, op, value }]);
  expect(m("<", "40")).toBe(true);
  expect(m("<", "30")).toBe(false);
  expect(m(">=", "30")).toBe(true);
  expect(m(">=", "31")).toBe(false);
  expect(m("<=", "30")).toBe(true);
  expect(m("<=", "29")).toBe(false);
  expect(m("ends", "1234", "name")).toBe(true);
  expect(m("ends", "HD", "name")).toBe(false);
  // A comparison against a non-number never matches, whichever side.
  expect(m(">", "abc")).toBe(false);
  expect(m(">", "10", "name")).toBe(false);
  // An operator this version doesn't know (e.g. from an old link) lets the
  // row through rather than hiding everything.
  expect(m("matches", "x")).toBe(true);
});

test("matchRow: a malformed range matches nothing", () => {
  const f = (v: string, t = "5") =>
    matchRow(0, { t }, [{ col: "t", op: "between", value: v }]);
  expect(f("a, 10")).toBe(false); // separator present, a bound isn't a number
  expect(f("1-x")).toBe(false); // bare hyphen, a bound isn't a number
  expect(f("1, 2, 3")).toBe(false); // not two bounds
  expect(f("10")).toBe(false); // one bound
  expect(f("1, 10", "n/a")).toBe(false); // the cell isn't a number
  // Bounds may come in either order.
  expect(f("10, 1")).toBe(true);
});

test("matchRow: a missing cell compares as empty", () => {
  expect(matchRow(0, {}, [{ col: "x", op: "=", value: "" }])).toBe(true);
  expect(matchRow(0, { x: null }, [{ col: "x", op: "~", value: "a" }])).toBe(false);
});

test("seqFilterToFilters skips clauses that carry no value", () => {
  // "gte" with nothing after it, an empty "between", and a stray separator.
  expect(seqFilterToFilters("gte-between-lt10--")).toEqual([
    { col: SEQ_COL, op: "<", value: "10" },
  ]);
  expect(seqFilterToFilters("  ")).toEqual([]);
  expect(filtersToSeqFilter([])).toBeNull();
});

test("sampleValues stops at its limit and skips blanks", () => {
  const m: Metadata = {};
  for (let i = 0; i < 12; i++) m[String(i)] = { c: i % 3 === 0 ? "—" : `v${i}` };
  const got = sampleValues(m, "c", 5);
  expect(got).toEqual(["v1", "v2", "v4", "v5", "v7"]);
});

test("inferType: a column with no values reads as string", () => {
  expect(inferType({ "1": { c: "" }, "2": { c: null } }, "c")).toBe("string");
  expect(inferType({}, SEQ_COL)).toBe("number");
});

test("opLabel falls back to the raw op for one it doesn't know", () => {
  expect(opLabel("number", "~")).toBe("~");
});

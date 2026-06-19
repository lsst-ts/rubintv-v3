import { inferType, matchRow, opLabel, sampleValues } from "./filters";
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
  expect(matchRow(meta["1"], [])).toBe(true);
  expect(matchRow(undefined, [])).toBe(true);
});

test("matchRow: string operators", () => {
  expect(matchRow(meta["1"], [{ col: "filter", op: "=", value: "z_20" }])).toBe(true);
  expect(matchRow(meta["2"], [{ col: "filter", op: "=", value: "z_20" }])).toBe(false);
  expect(matchRow(meta["1"], [{ col: "filter", op: "~", value: "20" }])).toBe(true);
  expect(matchRow(meta["1"], [{ col: "target", op: "starts", value: "low" }])).toBe(true);
  expect(
    matchRow(meta["1"], [{ col: "filter", op: "in", value: "r_03, z_20" }]),
  ).toBe(true);
});

test("matchRow: number operators incl. between", () => {
  expect(matchRow(meta["1"], [{ col: "exp", op: ">", value: "20" }])).toBe(true);
  expect(matchRow(meta["2"], [{ col: "exp", op: ">", value: "20" }])).toBe(false);
  expect(
    matchRow(meta["1"], [{ col: "exp", op: "between", value: "25, 40" }]),
  ).toBe(true);
  expect(
    matchRow(meta["3"], [{ col: "exp", op: "between", value: "25, 40" }]),
  ).toBe(false);
});

test("matchRow: every filter must match (AND)", () => {
  const f = [
    { col: "filter", op: "=", value: "z_20" },
    { col: "exp", op: ">", value: "20" },
  ];
  expect(matchRow(meta["1"], f)).toBe(true); // z_20 & 30>20
  expect(matchRow(meta["3"], f)).toBe(true); // z_20 & 45>20
  expect(matchRow(meta["2"], f)).toBe(false); // r_03
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

import { expect, test } from "vitest";
import { formatCell } from "./CameraDataTable";

test("integers render without a spurious .000 suffix", () => {
  // Regression: the old unconditional toFixed(3) rendered every JSON number
  // (incl. whole numbers) as e.g. "5.000".
  expect(formatCell(5)).toEqual({ display: "5" });
  expect(formatCell(-12)).toEqual({ display: "-12" });
  expect(formatCell(0)).toEqual({ display: "0" });
});

test("fractional values are truncated to 3dp with a full-value tooltip", () => {
  expect(formatCell(1.5)).toEqual({ display: "1.500", title: "1.5" });
  expect(formatCell(1.23456)).toEqual({ display: "1.234", title: "1.23456" });
});

test("non-numeric and empty values pass through", () => {
  expect(formatCell("lowdust")).toEqual({ display: "lowdust" });
  expect(formatCell("")).toEqual({ display: "—" });
  expect(formatCell(null)).toEqual({ display: "—" });
  expect(formatCell(undefined)).toEqual({ display: "—" });
  // A numeric string that is a whole number stays as-is.
  expect(formatCell("5")).toEqual({ display: "5" });
});

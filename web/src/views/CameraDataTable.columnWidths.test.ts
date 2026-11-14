import { expect, test } from "vitest";
import { MAX_META_CH, metaColumnChars } from "./CameraDataTable";

const columns = [
  { key: "seq", label: "Seq.No" },
  { key: "ch:im", label: "Image" },
  { key: "meta:Group name", label: "Group name" },
  { key: "meta:Elevation", label: "Elevation" },
];

test("each metadata column takes its widest value across all rows", () => {
  const chars = metaColumnChars(columns, {
    "1": { "Group name": "2026-07-15T00:18:08.828#5", Elevation: 22 },
    "2": { "Group name": "short", Elevation: 21.99912 },
    // Hidden columns and "_<col>" flag keys aren't scanned.
    "3": { Other: "x".repeat(30), "_Group name": "a-very-long-flag-class-name" },
  });
  expect(chars).toEqual({
    "meta:Group name": 25,
    // Floats are measured as displayed (truncated to 3dp), not at full length.
    "meta:Elevation": "21.999".length,
  });
});

test("an outlier value is capped", () => {
  const chars = metaColumnChars(columns, {
    "1": { "Group name": "x".repeat(MAX_META_CH + 50) },
  });
  expect(chars["meta:Group name"]).toBe(MAX_META_CH);
});

test("foldout cells count their button label, icon-only ones nothing", () => {
  const chars = metaColumnChars(columns, {
    "1": { "Group name": { DISPLAY_VALUE: "details", a: 1 }, Elevation: [1, 2] },
  });
  expect(chars).toEqual({ "meta:Group name": "details".length + 2 });
});

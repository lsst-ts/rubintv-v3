import {
  createPlaceholders,
  getStatusClass,
  getStatusColor,
} from "./detectorUtils";

// Cluster Status's worker-state styling: each known state has its own class
// and canvas colour; anything else (including no report yet) reads as missing.

test.each([
  ["free", "status-free", "#22c55e"],
  ["busy", "status-busy", "#eab308"],
  ["queued", "status-queued", "#ef4444"],
  ["restarting", "status-restarting", "#a163ac"],
  ["guest", "status-guest", "#3b82f6"],
  ["missing", "status-missing", "#d1d5db"],
  ["something-new", "status-missing", "#d1d5db"],
])("%s → %s, %s", (status, cls, color) => {
  expect(getStatusClass(status)).toBe(cls);
  expect(getStatusColor(status)).toBe(color);
});

test("placeholders give a set its advertised worker count, all missing", () => {
  expect(createPlaceholders(3)).toEqual({
    "0": { status: "missing" },
    "1": { status: "missing" },
    "2": { status: "missing" },
  });
  expect(createPlaceholders(0)).toEqual({});
});

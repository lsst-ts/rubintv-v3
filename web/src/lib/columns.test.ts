import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useColumnPrefs } from "./columns";

const LOC = "loc";
const CAM = "cam";
const KEY = `rubintv.columns.${LOC}.${CAM}`;

afterEach(() => localStorage.clear());

// "Retrieval fails" is a locked column (configured per-camera via
// `locked_columns`): always shown, never hidden, and the picker offers it
// ghosted (checked + disabled) — see CameraTable.
const ALL = ["Retrieval fails", "Exposure time", "Airmass"];
const DEFAULTS = ["Retrieval fails", "Exposure time"];
const LOCKED = ["Retrieval fails"];

function setup() {
  return renderHook(() => useColumnPrefs(LOC, CAM, ALL, DEFAULTS, LOCKED));
}

test("locked column starts visible and not hidden", () => {
  const { result } = setup();
  expect(result.current.visible).toContain("Retrieval fails");
  expect(result.current.hidden.has("Retrieval fails")).toBe(false);
  expect(result.current.locked.has("Retrieval fails")).toBe(true);
});

test("a column not in locked_columns is not locked", () => {
  const { result } = setup();
  expect(result.current.locked.has("Exposure time")).toBe(false);
});

test("toggling a locked column is a no-op", () => {
  const { result } = setup();
  act(() => result.current.toggle("Retrieval fails"));
  expect(result.current.hidden.has("Retrieval fails")).toBe(false);
  expect(result.current.visible).toContain("Retrieval fails");
});

test("hideAll leaves the locked column visible", () => {
  const { result } = setup();
  act(() => result.current.hideAll());
  expect(result.current.visible).toEqual(["Retrieval fails"]);
  expect(result.current.hidden.has("Retrieval fails")).toBe(false);
});

test("a stale saved pref hiding the locked column is ignored", () => {
  localStorage.setItem(KEY, JSON.stringify(["Retrieval fails", "Airmass"]));
  const { result } = setup();
  expect(result.current.hidden.has("Retrieval fails")).toBe(false);
  expect(result.current.visible).toContain("Retrieval fails");
  // The non-locked saved hide still applies.
  expect(result.current.hidden.has("Airmass")).toBe(true);
});

test("with no locked columns, every column is hideable", () => {
  const { result } = renderHook(() =>
    useColumnPrefs(LOC, CAM, ALL, DEFAULTS),
  );
  expect(result.current.locked.size).toBe(0);
  act(() => result.current.toggle("Retrieval fails"));
  expect(result.current.hidden.has("Retrieval fails")).toBe(true);
});

// A wider column universe to exercise pick-order without the locked column
// clouding the sequence. Defaults show B and C; A and D start hidden.
const WIDE = ["A", "B", "C", "D"];
const WIDE_DEFAULTS = ["B", "C"];
function wide() {
  return renderHook(() => useColumnPrefs(LOC, CAM, WIDE, WIDE_DEFAULTS));
}

test("newly-shown columns append in the order they were checked", () => {
  const { result } = wide();
  expect(result.current.visible).toEqual(["B", "C"]);
  act(() => result.current.toggle("D")); // turn D on
  act(() => result.current.toggle("A")); // then A
  // Untouched defaults keep their order; picked columns follow in pick order.
  expect(result.current.visible).toEqual(["B", "C", "D", "A"]);
});

test("re-checking a column moves it to the end", () => {
  const { result } = wide();
  act(() => result.current.toggle("A")); // on: [B, C, A]
  act(() => result.current.toggle("D")); // on: [B, C, A, D]
  act(() => result.current.toggle("A")); // off: [B, C, D]
  act(() => result.current.toggle("A")); // on again → to the end
  expect(result.current.visible).toEqual(["B", "C", "D", "A"]);
});

test("hiding a picked column removes it from the order", () => {
  const { result } = wide();
  act(() => result.current.toggle("A")); // [B, C, A]
  act(() => result.current.toggle("A")); // hide A → [B, C]
  expect(result.current.visible).toEqual(["B", "C"]);
});

test("pick order persists across remounts", () => {
  const { result, unmount } = wide();
  act(() => result.current.toggle("D"));
  act(() => result.current.toggle("A"));
  unmount();
  const { result: r2 } = wide();
  expect(r2.current.visible).toEqual(["B", "C", "D", "A"]);
});

test("reset restores config order and clears the pick order", () => {
  const { result } = wide();
  act(() => result.current.toggle("D"));
  act(() => result.current.toggle("A"));
  act(() => result.current.reset());
  expect(result.current.visible).toEqual(["B", "C"]);
});

test("showAll orders every column by the config/data order", () => {
  const { result } = wide();
  act(() => result.current.toggle("D")); // establish a stale pick order
  act(() => result.current.showAll());
  expect(result.current.visible).toEqual(["A", "B", "C", "D"]);
});

test("a saved hidden pref with no order key keeps config order", () => {
  // Migration case: a pref that predates ordering has only the hidden-set key.
  localStorage.setItem(KEY, JSON.stringify(["A"])); // hide A, show B/C/D
  const { result } = wide();
  expect(result.current.visible).toEqual(["B", "C", "D"]);
});

test("reorder pins the visible columns into the given order", () => {
  const { result } = wide(); // defaults show [B, C]
  // Drag C before B.
  act(() => result.current.reorder(["C", "B"]));
  expect(result.current.visible).toEqual(["C", "B"]);
});

test("reorder can move a config-default column past a picked one", () => {
  const { result } = wide(); // [B, C]
  act(() => result.current.toggle("D")); // [B, C, D]
  // Drag the default column B to the end, after the picked D.
  act(() => result.current.reorder(["C", "D", "B"]));
  expect(result.current.visible).toEqual(["C", "D", "B"]);
});

test("reorder ignores unknown or hidden names", () => {
  const { result } = wide(); // [B, C]
  // "ZZ" isn't a real column and A is hidden — both are dropped; order sticks
  // for the valid, visible ones.
  act(() => result.current.reorder(["C", "ZZ", "A", "B"]));
  expect(result.current.visible).toEqual(["C", "B"]);
});

test("a reordered layout persists across remounts", () => {
  const { result, unmount } = wide();
  act(() => result.current.reorder(["C", "B"]));
  unmount();
  const { result: r2 } = wide();
  expect(r2.current.visible).toEqual(["C", "B"]);
});

test("reset clears a drag-reordered layout", () => {
  const { result } = wide();
  act(() => result.current.reorder(["C", "B"]));
  act(() => result.current.reset());
  expect(result.current.visible).toEqual(["B", "C"]); // back to config order
});

test("a column shown after a reorder sorts ahead of the pinned set", () => {
  const { result } = wide(); // [B, C]
  act(() => result.current.reorder(["C", "B"])); // pin [C, B]
  act(() => result.current.toggle("A")); // turn on A (a fresh pick)
  // A is picked → appended after the pinned set; the pinned pair keeps order.
  expect(result.current.visible).toEqual(["C", "B", "A"]);
});

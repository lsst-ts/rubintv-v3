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

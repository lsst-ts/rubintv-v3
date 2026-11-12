import { act, renderHook } from "@testing-library/react";
import { useAutoHideTopbar, useDensity } from "./prefs";

// The NavMenu's per-browser prefs: read from localStorage, shared live between
// every reader. Picking them in the menu, and blocked storage, are covered in
// NavMenu.test; the table applying them, in the table tests.

beforeEach(() => localStorage.clear());

test("an unrecognised stored value reads as the default", () => {
  localStorage.setItem("rubintv.density", "spacious");
  localStorage.setItem("rubintv.autoHideTopbar", "maybe");
  const { result } = renderHook(() => [useDensity()[0], useAutoHideTopbar()[0]]);
  expect(result.current).toEqual(["regular", true]);
});

test("a change reaches every reader", () => {
  const a = renderHook(() => useAutoHideTopbar());
  const b = renderHook(() => useAutoHideTopbar());
  act(() => a.result.current[1](false));
  expect(b.result.current[0]).toBe(false);
});

import { act, renderHook } from "@testing-library/react";
import { usePersistentToggle } from "./usePersistentToggle";

// A boolean flag remembered in localStorage (e.g. the channel view's folded
// metadata panel); best-effort where storage is unavailable.

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("starts from the fallback, then from whatever was saved", () => {
  const first = renderHook(() => usePersistentToggle("k", true));
  expect(first.result.current[0]).toBe(true);
  act(() => first.result.current[1](false));
  expect(first.result.current[0]).toBe(false);
  expect(localStorage.getItem("k")).toBe("false");

  // A saved "false" beats a true fallback, and vice versa.
  expect(renderHook(() => usePersistentToggle("k", true)).result.current[0])
    .toBe(false);
  localStorage.setItem("k", "true");
  expect(renderHook(() => usePersistentToggle("k", false)).result.current[0])
    .toBe(true);
});

test("a garbled saved value falls back", () => {
  localStorage.setItem("k", "yes");
  expect(renderHook(() => usePersistentToggle("k", true)).result.current[0])
    .toBe(true);
});

test("without storage it still toggles for the session", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const { result } = renderHook(() => usePersistentToggle("k", false));
  expect(result.current[0]).toBe(false);
  act(() => result.current[1](true));
  expect(result.current[0]).toBe(true);
});

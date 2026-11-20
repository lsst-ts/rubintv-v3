import { getCameraTabPref, setCameraTabPref } from "./cameraTabPref";

// The remembered Table/Channels choice. Navigation flows (the redirect to a
// stored Channels tab, recording a click) are in routes.test; these pin the
// storage edge cases.

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("only Table and Channels are remembered", () => {
  setCameraTabPref("channels");
  expect(getCameraTabPref()).toBe("channels");
  // Nightly Summary / live view are destinations, not a preference.
  setCameraTabPref("nightreport");
  expect(getCameraTabPref()).toBe("channels");
  setCameraTabPref("table");
  expect(getCameraTabPref()).toBe("table");
});

test("unavailable storage reads as Table and ignores writes", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => setCameraTabPref("channels")).not.toThrow();
  expect(getCameraTabPref()).toBe("table");
});

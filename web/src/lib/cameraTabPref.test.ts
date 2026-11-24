import {
  getCameraTabPref,
  noteCameraTabShown,
  setCameraTabPref,
} from "./cameraTabPref";

// The remembered Table/Channels choice. Navigation flows (the redirect to a
// stored Channels tab, recording a click) are in routes.test; these pin the
// storage edge cases.
//
// The choice is each browser tab's own (sessionStorage), seeded from the last
// one made in any tab (localStorage). jsdom is a single tab, so another tab's
// pick is played by writing localStorage directly, and a new tab by clearing
// sessionStorage.
const KEY = "rubintv.cameraTab";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
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

test("a value this app never wrote reads as nothing remembered", () => {
  sessionStorage.setItem(KEY, "mosaic");
  localStorage.setItem(KEY, "mosaic");
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
  expect(() => noteCameraTabShown("channels")).not.toThrow();
  expect(getCameraTabPref()).toBe("table");
});

test("a new tab starts from the last choice made in any tab", () => {
  localStorage.setItem(KEY, "channels");
  expect(getCameraTabPref()).toBe("channels");
});

test("a tab's choice, once read, is not moved by a pick in another tab", () => {
  expect(getCameraTabPref()).toBe("table");
  localStorage.setItem(KEY, "channels");
  expect(getCameraTabPref()).toBe("table");
});

test("a view come back to is this tab's choice, and not the next new tab's", () => {
  setCameraTabPref("channels");
  noteCameraTabShown("table");
  expect(getCameraTabPref()).toBe("table");
  // A tab opened after that still starts from the last pick.
  sessionStorage.clear();
  expect(getCameraTabPref()).toBe("channels");
});

test("a pick is kept for this tab and seeds the next new one", () => {
  setCameraTabPref("channels");
  // Another tab picks Table: this one keeps Channels...
  localStorage.setItem(KEY, "table");
  expect(getCameraTabPref()).toBe("channels");
  // ...and a tab opened after that starts on the Table.
  sessionStorage.clear();
  expect(getCameraTabPref()).toBe("table");
});

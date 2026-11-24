// The user's last-chosen camera view tab (Table vs Channels), remembered so
// that opening a different camera lands on the same tab they were last using —
// the tab is otherwise purely URL-derived (useShellNav), so every new camera
// would default back to Table.
//
// Only the Table/Channels toggle is remembered: those are the two the user
// actively switches between on a normal camera. Night-report / live-view are
// camera-specific destinations, not a standing preference, so we never store
// them (and never steer a new camera to them).
//
// The choice belongs to the browser tab. Each tab keeps its own in
// sessionStorage, which a reload keeps and a duplicated tab copies, so picking
// Channels in one tab never moves a table that is open in another.
// localStorage holds the last choice made in any tab, and only seeds a tab
// that has none of its own yet: a new tab opens the way the user last left
// things, then goes its own way.
//
// A tab's choice is the view it last showed, however it got there: a click on
// the Table or Channels tab picks it (setCameraTabPref), and so does coming
// back to one of them with Back or Forward, or loading its URL
// (noteCameraTabShown).

const KEY = "rubintv.cameraTab";

export type CameraTabPref = "table" | "channels";

function read(storage: Storage): CameraTabPref | null {
  const value = storage.getItem(KEY);
  return value === "table" || value === "channels" ? value : null;
}

// Read this tab's preference, defaulting to "table" (the historical behaviour
// and the base route) when nothing is stored or storage is unavailable. The
// first read in a tab settles its choice, so a later pick in another tab
// can't change it.
export function getCameraTabPref(): CameraTabPref {
  try {
    const own = read(sessionStorage);
    if (own) return own;
    const seed = read(localStorage) ?? "table";
    sessionStorage.setItem(KEY, seed);
    return seed;
  } catch {
    return "table";
  }
}

// Record the view this browser tab has come back to or loaded. It is the
// tab's own choice from here on, and no one else's: the seed for new tabs
// follows the tabs a user clicks, not the pages their history passes through.
export function noteCameraTabShown(tab: CameraTabPref): void {
  try {
    sessionStorage.setItem(KEY, tab);
  } catch {
    // ignore quota / disabled storage
  }
}

// Record the tab the user just switched to, for this browser tab and as the
// seed for the next new one. Ignores anything that isn't one of the two
// remembered tabs, so clicking Nightly Summary leaves the preference alone.
export function setCameraTabPref(tab: string): void {
  if (tab !== "table" && tab !== "channels") return;
  try {
    sessionStorage.setItem(KEY, tab);
    localStorage.setItem(KEY, tab);
  } catch {
    // ignore quota / disabled storage
  }
}

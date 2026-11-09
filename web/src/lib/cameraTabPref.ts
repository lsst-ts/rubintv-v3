// The user's last-chosen camera view tab (Table vs Channels), persisted to
// localStorage so opening a different camera lands on the same tab they were
// last using — the tab is otherwise purely URL-derived (useShellNav), so every
// new camera would default back to Table.
//
// Only the Table/Channels toggle is remembered: those are the two the user
// actively switches between on a normal camera. Night-report / live-view are
// camera-specific destinations, not a standing preference, so we never store
// them (and never steer a new camera to them).

const KEY = "rubintv.cameraTab";

export type CameraTabPref = "table" | "channels";

// Read the saved preference, defaulting to "table" (the historical behaviour and
// the base route) when nothing is stored or storage is unavailable.
export function getCameraTabPref(): CameraTabPref {
  try {
    return localStorage.getItem(KEY) === "channels" ? "channels" : "table";
  } catch {
    return "table";
  }
}

// Record the tab the user just switched to. Ignores anything that isn't one of
// the two remembered tabs, so clicking Night report leaves the preference alone.
export function setCameraTabPref(tab: string): void {
  if (tab !== "table" && tab !== "channels") return;
  try {
    localStorage.setItem(KEY, tab);
  } catch {
    // ignore quota / disabled storage
  }
}

import { useSyncExternalStore } from "react";

// Per-browser preferences set in the NavMenu and applied elsewhere (the camera
// table). Each is read through its hook wherever it's needed, so a change in
// the menu reaches a view already on screen. Persisted to localStorage; where
// that's blocked (private mode), a change holds in memory for the session.

function createPref<T extends string>(
  key: string,
  values: readonly T[],
  fallback: T,
) {
  const listeners = new Set<() => void>();
  // The last change, read only while storage is unavailable.
  let unstored = fallback;

  const read = (): T => {
    try {
      const v = localStorage.getItem(key) as T | null;
      return v !== null && values.includes(v) ? v : fallback;
    } catch {
      return unstored;
    }
  };
  const subscribe = (onChange: () => void) => {
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  };
  const set = (v: T) => {
    unstored = v;
    try {
      localStorage.setItem(key, v);
    } catch {
      // Persist is best-effort; the in-memory change still applies.
    }
    for (const onChange of listeners) onChange();
  };
  const use = (): T => useSyncExternalStore(subscribe, read);
  return { use, set };
}

// Table row density (compact / regular).
export type Density = "compact" | "regular";
const density = createPref<Density>(
  "rubintv.density",
  ["compact", "regular"],
  "regular",
);
export const setDensity = density.set;
export function useDensity(): [Density, (d: Density) => void] {
  return [density.use(), setDensity];
}

// Whether the camera table hides the topbar while it's scrolled down, so the
// table fills the window. On unless turned off.
const autoHideTopbar = createPref("rubintv.autoHideTopbar", ["on", "off"], "on");
export const setAutoHideTopbar = (on: boolean) =>
  autoHideTopbar.set(on ? "on" : "off");
export function useAutoHideTopbar(): [boolean, (on: boolean) => void] {
  return [autoHideTopbar.use() === "on", setAutoHideTopbar];
}

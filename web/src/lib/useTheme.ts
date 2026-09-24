import { useEffect, useState } from "react";

// Light / dark / system theme, persisted to localStorage and applied as a
// data-theme attribute on <html> (the CSS in index.css keys both palettes off
// it). "system" follows the OS preference and tracks live changes to it. The
// no-flash boot script in index.html resolves the same stored value before
// React mounts; this hook keeps it in sync thereafter.

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "rubintv-theme";

function readStored(): ThemeMode {
  try {
    const m = localStorage.getItem(STORAGE_KEY);
    if (m === "light" || m === "dark" || m === "system") return m;
  } catch {
    // localStorage unavailable (private mode / blocked) — fall through.
  }
  return "system";
}

// The OS dark-mode query, or null where matchMedia isn't available (older
// engines, jsdom). Callers treat null as "no system preference → light".
function darkQuery(): MediaQueryList | null {
  if (typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-color-scheme: dark)");
}

// The concrete palette a mode resolves to right now.
function resolve(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return darkQuery()?.matches ? "dark" : "light";
}

export function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setModeState] = useState<ThemeMode>(readStored);

  // Apply the resolved palette whenever the mode changes, and — when on
  // "system" — re-apply if the OS preference flips while we're mounted.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolve(mode));
    if (mode !== "system") return;
    const mq = darkQuery();
    if (!mq) return;
    const onChange = () => {
      document.documentElement.setAttribute("data-theme", resolve("system"));
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = (next: ThemeMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persist is best-effort; the in-memory state still applies for the session.
    }
    setModeState(next);
  };

  return [mode, setMode];
}

import { useState } from "react";

// A boolean flag persisted to localStorage under `key`, shared across the app
// (the same key in any view reads/writes the same stored value). Persisting is
// best-effort: where localStorage is unavailable (private mode, jsdom) the flag
// still works for the session. Mirrors the theme/density persistence pattern.
export function usePersistentToggle(
  key: string,
  fallback: boolean,
): [boolean, (next: boolean) => void] {
  const [on, setOnState] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      if (v === "true") return true;
      if (v === "false") return false;
    } catch {
      // ignore — fall through to the fallback
    }
    return fallback;
  });

  const setOn = (next: boolean) => {
    try {
      localStorage.setItem(key, String(next));
    } catch {
      // ignore — in-memory state still applies for the session
    }
    setOnState(next);
  };

  return [on, setOn];
}

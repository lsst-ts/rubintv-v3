// Per-camera metadata column visibility, persisted to localStorage. Returns
// the selected set and a toggle. Defaults to all columns visible.

import { useCallback, useEffect, useState } from "react";

function storageKey(location: string, camera: string): string {
  return `rubintv.columns.${location}.${camera}`;
}

export function useColumnPrefs(location: string, camera: string, all: string[]) {
  const key = storageKey(location, camera);
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify([...hidden]));
    } catch {
      // ignore quota / disabled storage
    }
  }, [key, hidden]);

  const toggle = useCallback((col: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  }, []);

  const visible = all.filter((c) => !hidden.has(c));
  return { visible, hidden, toggle };
}

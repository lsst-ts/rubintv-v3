// Per-camera metadata column visibility, persisted to localStorage. Returns
// the selected set and a toggle. Defaults to all columns visible.

import { useCallback, useEffect, useMemo, useState } from "react";

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

  // Memoize so `visible`'s identity only changes when the column set or the
  // hidden set actually change — not on every parent render. A fresh array
  // here cascades into the camera table's `columns` memo and re-runs the
  // angled-header measurement (a full reflow over every <th>) on unrelated
  // state changes, e.g. opening the column picker.
  const visible = useMemo(() => all.filter((c) => !hidden.has(c)), [all, hidden]);
  return { visible, hidden, toggle };
}

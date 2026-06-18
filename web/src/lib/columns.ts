// Per-camera metadata column visibility, persisted to localStorage. The
// per-camera `metadata_columns` config is the default-visible set; every other
// key seen in the metadata is a column too but hidden until added. Returns the
// selected set, a toggle, and bulk actions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function storageKey(location: string, camera: string): string {
  return `rubintv.columns.${location}.${camera}`;
}

// The hidden set that shows only `defaults` out of `all`.
function defaultHidden(all: string[], defaults: string[]): Set<string> {
  const shown = new Set(defaults);
  return new Set(all.filter((c) => !shown.has(c)));
}

export function useColumnPrefs(
  location: string,
  camera: string,
  all: string[],
  defaults: string[],
) {
  const key = storageKey(location, camera);

  // Whether the user has an explicit saved preference. Without one, the visible
  // set tracks the configured defaults (so newly-streamed default columns show,
  // and non-default columns stay hidden) rather than a frozen snapshot.
  const hasSaved = useRef<boolean>(false);
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        hasSaved.current = true;
        return new Set(JSON.parse(raw) as string[]);
      }
    } catch {
      // fall through to defaults
    }
    return defaultHidden(all, defaults);
  });

  // Until the user customises, keep hidden = (all − defaults) as both lists
  // settle (config + streamed metadata arrive after mount).
  useEffect(() => {
    if (hasSaved.current) return;
    setHidden(defaultHidden(all, defaults));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.join(""), defaults.join("")]);

  // Persist only once the user has actively changed something, so we never
  // freeze the auto-default into storage and stop tracking new default columns.
  const persist = useCallback(
    (next: Set<string>) => {
      hasSaved.current = true;
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        // ignore quota / disabled storage
      }
    },
    [key],
  );

  const toggle = useCallback(
    (col: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(col)) next.delete(col);
        else next.add(col);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  // Bulk actions over the known column set.
  const showAll = useCallback(() => {
    setHidden((prev) => {
      const next = new Set(prev);
      for (const c of all) next.delete(c);
      persist(next);
      return next;
    });
  }, [all, persist]);
  const hideAll = useCallback(() => {
    setHidden((prev) => {
      const next = new Set(prev);
      for (const c of all) next.add(c);
      persist(next);
      return next;
    });
  }, [all, persist]);
  // Reset restores the configured defaults (show metadata_columns, hide rest).
  const reset = useCallback(() => {
    const next = defaultHidden(all, defaults);
    persist(next);
    setHidden(next);
  }, [all, defaults, persist]);

  // Memoize so `visible`'s identity only changes when the column set or the
  // hidden set actually change — not on every parent render. A fresh array
  // here cascades into the camera table's `columns` memo and re-runs the
  // angled-header measurement (a full reflow over every <th>) on unrelated
  // state changes, e.g. opening the column picker.
  const visible = useMemo(() => all.filter((c) => !hidden.has(c)), [all, hidden]);
  return { visible, hidden, toggle, showAll, hideAll, reset };
}

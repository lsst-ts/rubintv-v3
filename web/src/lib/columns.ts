// Per-camera metadata column visibility and order, persisted to localStorage.
// The per-camera `metadata_columns` config is the default-visible set; every
// other key seen in the metadata is a column too but hidden until added.
// Returns the ordered visible set, a toggle, and bulk actions.
//
// Ordering: columns the user turns on in the picker are appended to the table
// in the order they were checked (re-checking moves a column to the end).
// Columns the user has never touched keep their config/data order at the front.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function storageKey(location: string, camera: string): string {
  return `rubintv.columns.${location}.${camera}`;
}

// Sibling key holding the pick order (an array of column names in the sequence
// the user checked them). Kept separate from the hidden-set key so old prefs
// that predate ordering still load unchanged (they just have no saved order).
function orderKey(location: string, camera: string): string {
  return `rubintv.columns.${location}.${camera}.order`;
}

// Order the visible columns. Columns present in `order` (either turned on via
// the picker or placed by a drag) come in that explicit sequence; columns not
// yet in `order` — config defaults/locked columns the user hasn't touched, or a
// column that only just streamed in — keep their config/data position in `all`,
// ahead of the explicitly-ordered set. After a full drag-reorder every visible
// column is in `order`, so the whole list follows the dragged sequence and only
// a newly-appearing column would (briefly) sort to the front until dragged.
function orderVisible(
  all: string[],
  hidden: Set<string>,
  order: string[],
): string[] {
  const picked = new Set(order);
  const untouched = all.filter((c) => !hidden.has(c) && !picked.has(c));
  const inOrder = order.filter((c) => all.includes(c) && !hidden.has(c));
  return [...untouched, ...inOrder];
}

// The hidden set that shows only `defaults` out of `all`. Locked columns —
// configured per-camera via `locked_columns`, always shown and not hideable —
// are never placed in the hidden set.
function defaultHidden(
  all: string[],
  defaults: string[],
  locked: Set<string>,
): Set<string> {
  const shown = new Set(defaults);
  return new Set(all.filter((c) => !shown.has(c) && !locked.has(c)));
}

export function useColumnPrefs(
  location: string,
  camera: string,
  all: string[],
  defaults: string[],
  // Columns that are always shown when present and can't be hidden. The picker
  // still lists them (checked + disabled), mirroring the old app where
  // "Retrieval fails" appeared ghosted-out.
  lockedColumns: string[] = [],
) {
  const key = storageKey(location, camera);
  const okey = orderKey(location, camera);
  // Memoize the lookup set so its identity is stable across renders (the array
  // arrives fresh from the API payload each time).
  const locked = useMemo(
    () => new Set(lockedColumns),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lockedColumns.join("\0")],
  );

  // Whether the user has an explicit saved preference. Without one, the visible
  // set tracks the configured defaults (so newly-streamed default columns show,
  // and non-default columns stay hidden) rather than a frozen snapshot.
  const hasSaved = useRef<boolean>(false);
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        hasSaved.current = true;
        // Drop any locked columns a stale pref may carry — they're never hidden.
        const saved = (JSON.parse(raw) as string[]).filter((c) => !locked.has(c));
        return new Set(saved);
      }
    } catch {
      // fall through to defaults
    }
    return defaultHidden(all, defaults, locked);
  });

  // The pick order (columns the user has turned on, in check sequence). Loaded
  // from its sibling key; absent for prefs that predate ordering, in which case
  // it stays empty and every visible column keeps its config/data order.
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(okey);
      if (raw) return JSON.parse(raw) as string[];
    } catch {
      // fall through to empty
    }
    return [];
  });

  // Until the user customises, keep hidden = (all − defaults) as both lists
  // settle (config + streamed metadata arrive after mount).
  useEffect(() => {
    if (hasSaved.current) return;
    setHidden(defaultHidden(all, defaults, locked));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.join(""), defaults.join(""), locked]);

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
  const persistOrder = useCallback(
    (next: string[]) => {
      try {
        localStorage.setItem(okey, JSON.stringify(next));
      } catch {
        // ignore quota / disabled storage
      }
    },
    [okey],
  );

  const toggle = useCallback(
    (col: string) => {
      if (locked.has(col)) return; // can't hide locked columns
      // A column currently in `hidden` is being turned ON; otherwise OFF.
      // Derive this from the current set (not from inside the updater, which
      // must stay pure and can run twice in Strict Mode) so the order update
      // agrees with the visibility update.
      const turningOn = hidden.has(col);
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(col)) next.delete(col);
        else next.add(col);
        persist(next);
        return next;
      });
      // Turning a column on appends it to the pick order (moving it to the end
      // if it was already there); turning it off drops it. This is what makes
      // the table order follow the sequence the user checked columns in.
      setOrder((prev) => {
        const rest = prev.filter((c) => c !== col);
        const next = turningOn ? [...rest, col] : rest;
        persistOrder(next);
        return next;
      });
    },
    [hidden, persist, persistOrder, locked],
  );

  // Bulk actions over the known column set. Each also resets the pick order so
  // the table falls back to config/data order — a bulk op expresses no per-
  // column sequence, so keeping a stale order would scatter the result.
  const showAll = useCallback(() => {
    setHidden((prev) => {
      const next = new Set(prev);
      for (const c of all) next.delete(c);
      persist(next);
      return next;
    });
    setOrder([]);
    persistOrder([]);
  }, [all, persist, persistOrder]);
  const hideAll = useCallback(() => {
    setHidden((prev) => {
      const next = new Set(prev);
      for (const c of all) if (!locked.has(c)) next.add(c);
      persist(next);
      return next;
    });
    setOrder([]);
    persistOrder([]);
  }, [all, persist, persistOrder, locked]);
  // Reset restores the configured defaults (show metadata_columns, hide rest)
  // in their config order.
  const reset = useCallback(() => {
    const next = defaultHidden(all, defaults, locked);
    persist(next);
    setHidden(next);
    setOrder([]);
    persistOrder([]);
  }, [all, defaults, persist, persistOrder, locked]);

  // Reorder the visible columns to `next` (a full ordered list of the currently
  // visible column names, e.g. after a drag). This pins the whole visible set
  // into an explicit order — including config-default columns that until now
  // floated at the front in config order — so a drag anywhere sticks. Only
  // names that are actually known (`all`) and visible are kept; the persisted
  // `order` becomes exactly that list. Locked columns aren't reorderable, so
  // they stay out of `order` and keep their up-front config position.
  const reorder = useCallback(
    (next: string[]) => {
      const cleaned = next.filter(
        (c) => all.includes(c) && !hidden.has(c) && !locked.has(c),
      );
      setOrder(cleaned);
      persistOrder(cleaned);
      // A drag is an explicit customisation; make sure the visibility pref is
      // persisted too so a later default-tracking effect doesn't override it.
      hasSaved.current = true;
    },
    [all, hidden, locked, persistOrder],
  );

  // Memoize so `visible`'s identity only changes when the column set, the
  // hidden set, or the pick order actually change — not on every parent
  // render. A fresh array here cascades into the camera table's `columns` memo
  // and re-runs the angled-header measurement (a full reflow over every <th>)
  // on unrelated state changes, e.g. opening the column picker.
  const visible = useMemo(
    () => orderVisible(all, hidden, order),
    [all, hidden, order],
  );
  return { visible, hidden, locked, toggle, reorder, showAll, hideAll, reset };
}

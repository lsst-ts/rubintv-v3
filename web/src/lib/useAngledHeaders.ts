import { useEffect, useRef, useState, type RefObject } from "react";

// Measures each header cell's horizontal position so angled (-45°) header
// labels can be drawn in a separate overlay layer that scrolls in lockstep
// with the table. Ported from the design's angled-header effect (design/from-
// claude/Camera Table - Sidebar v2.html): labels live in an overlay rather than
// inside the <th> so a long label can extend rightward past its own (narrow)
// column, only truncated when its diagonal rise would exceed the header height.
//
// Returns refs to attach to the scroll wrapper and <thead>, the measured
// per-column left offsets, and the table's full width (for sizing the overlay).

export interface AngledHeaders {
  wrapRef: RefObject<HTMLDivElement | null>;
  headRef: RefObject<HTMLTableSectionElement | null>;
  positions: { left: number; width: number }[];
  tableWidth: number;
}

function samePositions(
  a: { left: number; width: number }[],
  b: { left: number; width: number }[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].left !== b[i].left || a[i].width !== b[i].width) return false;
  }
  return true;
}

// `deps` re-measures when the column set / widths change. `enabled` lets a
// caller turn measurement off (e.g. a non-angled header style).
export function useAngledHeaders(
  enabled: boolean,
  deps: unknown[],
): AngledHeaders {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLTableSectionElement | null>(null);
  const [positions, setPositions] = useState<{ left: number; width: number }[]>(
    [],
  );
  const [tableWidth, setTableWidth] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setPositions([]);
      setTableWidth(0);
      return;
    }
    const measure = () => {
      const head = headRef.current;
      const wrap = wrapRef.current;
      if (!head || !wrap) return;
      const ths = [...head.querySelectorAll("th")];
      const wrapRect = wrap.getBoundingClientRect();
      const sl = wrap.scrollLeft;
      // Position relative to the scroll-content origin so the overlay scrolls
      // horizontally in lockstep with the table.
      const next = ths.map((th) => {
        const r = th.getBoundingClientRect();
        return { left: r.left - wrapRect.left + sl, width: r.width };
      });
      const tbl = wrap.querySelector(".data-table") as HTMLElement | null;
      const nextW = tbl ? tbl.offsetWidth : 0;

      // Only commit when something actually changed. Writing identical state on
      // every ResizeObserver callback would re-trigger layout → the observer
      // again → an infinite loop (which hangs jsdom and pins a real browser).
      setPositions((prev) =>
        samePositions(prev, next) ? prev : next,
      );
      setTableWidth((prev) => (prev === nextW ? prev : nextW));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (headRef.current) ro.observe(headRef.current);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener("resize", measure);
    // Re-measure as the user scrolls horizontally (offsets are scroll-relative,
    // but a re-measure keeps them exact across layout shifts).
    const wrap = wrapRef.current;
    wrap?.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      wrap?.removeEventListener("scroll", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return { wrapRef, headRef, positions, tableWidth };
}

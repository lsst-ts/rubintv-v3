import {
  useCallback,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

// Drives the column picker's corner resize grips, which drag its right edge,
// and caps how far: to the width at which the longest column name shows in
// full in the select grid, or to main.app-content's right edge, whichever is
// narrower. When that cap is no wider than the popover's min-width the grips
// are hidden (data-resizable is dropped), since dragging would gain nothing.
// The grips are custom rather than CSS `resize`, whose grip can only sit
// bottom-right; pass the returned handler to each grip's onPointerDown.
//
// The grid keeps a fixed column count across the drag range (see .cols-grid),
// so each column takes 1/n of any width added to the popover and the full-name
// width follows from one measurement. max-width, width and data-resizable are
// written straight onto the popover, as ScrollingTitle does, so nothing
// re-renders.
//
// `gridShown` says whether the select grid currently has rows to measure. While
// it doesn't (reorder view, or a search with no matches) the last measurement
// stands; the reorder list is one full-width column, so its names fit anyway.
export function useColumnPickerWidth(
  popRef: RefObject<HTMLElement | null>,
  open: boolean,
  names: readonly string[],
  gridShown: boolean,
): (e: ReactPointerEvent<HTMLElement>) => void {
  const fitRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!open || !pop) return;
    const main = pop.closest<HTMLElement>(".app-content");
    const apply = () => {
      const popBox = pop.getBoundingClientRect();
      if (gridShown) {
        const fit = fullNameWidth(pop, popBox.width, names);
        if (fit !== null) fitRef.current = fit;
      }
      // Never measured: no room to grow (min-width wins over a max of 0).
      let max = fitRef.current ?? 0;
      if (main) {
        // Content-box right edge, so the popover lines up with the table.
        const contentRight =
          main.getBoundingClientRect().left +
          main.clientLeft +
          main.clientWidth -
          parseFloat(getComputedStyle(main).paddingRight);
        max = Math.min(max, contentRight - popBox.left);
      }
      pop.style.maxWidth = `${max}px`;
      const min = parseFloat(getComputedStyle(pop).minWidth);
      pop.toggleAttribute("data-resizable", max > min);
    };
    apply();
    // The content edge moves with the window (and any sidebar toggle).
    if (!main) return;
    const ro = new ResizeObserver(apply);
    ro.observe(main);
    return () => ro.disconnect();
  }, [popRef, open, names, gridShown]);

  // Drag: the right edge follows the pointer, held within min/max-width so
  // dragging back from past either bound responds at once. Pointer capture
  // keeps the moves coming to the grip wherever the pointer strays.
  return useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const pop = popRef.current;
      if (!pop || e.button !== 0) return;
      e.preventDefault(); // no text selection while dragging
      const grip = e.currentTarget;
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startWidth = pop.getBoundingClientRect().width;
      const cs = getComputedStyle(pop);
      const min = parseFloat(cs.minWidth);
      const max = parseFloat(cs.maxWidth);
      const move = (ev: PointerEvent) => {
        const w = Math.max(min, Math.min(max, startWidth + ev.clientX - startX));
        pop.style.width = `${w}px`;
      };
      const end = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("lostpointercapture", end);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("lostpointercapture", end);
    },
    [popRef],
  );
}

let canvas: HTMLCanvasElement | undefined;

// The popover width at which the widest of `names` fits its grid column, or
// null when there's no laid-out grid row to measure from (also the case in
// jsdom, which has no layout).
function fullNameWidth(
  pop: HTMLElement,
  popWidth: number,
  names: readonly string[],
): number | null {
  const grid = pop.querySelector<HTMLElement>(".cols-grid");
  const item = grid?.querySelector<HTMLElement>(".picker-item");
  const label = item?.querySelector<HTMLElement>(".scrolling-title");
  if (!grid || !item || !label || names.length === 0) return null;
  const itemBox = item.getBoundingClientRect();
  if (itemBox.width === 0) return null;
  // Room a name gets: from the label's start to the row's inner right edge.
  const room =
    itemBox.right -
    parseFloat(getComputedStyle(item).paddingRight) -
    label.getBoundingClientRect().left;
  // Columns in use: equal-width rows separated by column-gap.
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
  const cols = Math.round((grid.clientWidth + gap) / (itemBox.width + gap));
  // Measured off-DOM in the labels' font so names a search has filtered out
  // still count, and the cap doesn't shift while typing.
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const f = getComputedStyle(label);
  ctx.font = `${f.fontStyle} ${f.fontWeight} ${f.fontSize} ${f.fontFamily}`;
  const widest = Math.max(...names.map((n) => ctx.measureText(n).width));
  // Rounded up: the browser draws the ellipsis for a fraction of a pixel.
  return popWidth + cols * Math.ceil(widest - room);
}

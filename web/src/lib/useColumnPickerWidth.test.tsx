import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useColumnPickerWidth } from "./useColumnPickerWidth";

// The column picker's resize grips: how wide the popover may grow (enough to
// show the longest column name in full, but never past the content area's
// right edge) and the drag itself. jsdom has no layout, so the boxes, computed
// styles and text metrics a browser would supply are stubbed on a fixture:
//
//   main.app-content  (left 0, 1000 wide, 16px right padding → edge at 984)
//     div.pop         (left 100, 300 wide, min-width 260)
//       .cols-grid    (290 wide, 10px column gap → 2 columns of 140)
//         .picker-item (right edge 240, 8px right padding)
//           .scrolling-title (starts at 120, so a name gets 112px)
//
// Names measure 7px per character.

type Box = Partial<DOMRect>;
const boxes = new Map<Element, Box>();
const styles = new Map<Element, Partial<CSSStyleDeclaration>>();
const realRect = HTMLElement.prototype.getBoundingClientRect;
const realStyle = window.getComputedStyle;
const realGetContext = HTMLCanvasElement.prototype.getContext;
const realRO = globalThis.ResizeObserver;
let resize: (() => void) | null = null;

function el(tag: string, cls: string, parent?: HTMLElement) {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

let main: HTMLElement;
let pop: HTMLElement;
let item: HTMLElement;

beforeEach(() => {
  main = el("main", "app-content");
  pop = el("div", "pop", main);
  const grid = el("div", "cols-grid", pop);
  item = el("div", "picker-item", grid);
  const label = el("span", "scrolling-title", item);
  document.body.appendChild(main);

  boxes.set(main, { left: 0 });
  boxes.set(pop, { left: 100, width: 300 });
  boxes.set(item, { width: 140, right: 240 });
  boxes.set(label, { left: 120 });
  Object.defineProperty(main, "clientWidth", { value: 1000, configurable: true });
  Object.defineProperty(main, "clientLeft", { value: 0 });
  Object.defineProperty(grid, "clientWidth", { value: 290 });
  styles.set(main, { paddingRight: "16px" });
  styles.set(item, { paddingRight: "8px" });
  styles.set(grid, { columnGap: "10px" });
  styles.set(label, {
    fontStyle: "normal",
    fontWeight: "400",
    fontSize: "12px",
    fontFamily: "sans-serif",
  });

  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return { left: 0, right: 0, width: 0, ...boxes.get(this) } as DOMRect;
  };
  window.getComputedStyle = ((e: Element) => {
    // The popover's max-width is whatever the hook last wrote inline.
    if (e === pop) {
      return { minWidth: "260px", maxWidth: pop.style.maxWidth };
    }
    return styles.get(e) ?? {};
  }) as typeof window.getComputedStyle;
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: (s: string) => ({ width: s.length * 7 }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  globalThis.ResizeObserver = class {
    constructor(cb: () => void) {
      resize = cb;
    }
    observe() {}
    disconnect() {
      resize = null;
    }
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  main.remove();
  boxes.clear();
  styles.clear();
  HTMLElement.prototype.getBoundingClientRect = realRect;
  window.getComputedStyle = realStyle;
  HTMLCanvasElement.prototype.getContext = realGetContext;
  globalThis.ResizeObserver = realRO;
});

const LONG = "a_very_long_column_name_here"; // 28 chars = 196px
const SHORT = ["seq", "filter"];

function mount(names: readonly string[], gridShown = true, open = true) {
  const ref = { current: pop };
  return renderHook(
    (p: { names: readonly string[]; gridShown: boolean; open: boolean }) =>
      useColumnPickerWidth(ref, p.open, p.names, p.gridShown),
    { initialProps: { names, gridShown, open } },
  );
}

test("grows to fit the longest name in full", () => {
  mount(["exposure_time", LONG]);
  // 196px of name in 112px of room: 84px more per column, 2 columns → +168.
  expect(pop.style.maxWidth).toBe("468px");
  expect(pop.hasAttribute("data-resizable")).toBe(true);
});

test("never grows past the content area's right edge", () => {
  Object.defineProperty(main, "clientWidth", { value: 500 });
  mount([LONG]);
  // Edge at 500 - 16 = 484, popover starts at 100.
  expect(pop.style.maxWidth).toBe("384px");
});

test("a window resize moves the cap with the content edge", () => {
  mount([LONG]);
  expect(pop.style.maxWidth).toBe("468px");
  Object.defineProperty(main, "clientWidth", { value: 400 });
  act(() => resize?.());
  expect(pop.style.maxWidth).toBe("284px");
});

test("hides the grips when every name already fits", () => {
  mount(SHORT);
  // The cap works out narrower than min-width, so dragging gains nothing.
  expect(pop.hasAttribute("data-resizable")).toBe(false);
});

test("keeps the last measurement while the grid is hidden", () => {
  const { rerender } = mount([LONG]);
  // A search with no matches empties the grid: names change, nothing to
  // measure, so the cap stands rather than collapsing.
  boxes.set(item, { width: 0 });
  rerender({ names: SHORT, gridShown: false, open: true });
  expect(pop.style.maxWidth).toBe("468px");
  // Likewise a re-measure that finds no laid-out row to measure from.
  rerender({ names: [LONG], gridShown: true, open: true });
  expect(pop.style.maxWidth).toBe("468px");
});

test("without a laid-out grid row there is no room to grow", () => {
  boxes.set(item, { width: 0 });
  mount([LONG]);
  expect(pop.style.maxWidth).toBe("0px");
  expect(pop.hasAttribute("data-resizable")).toBe(false);
});

test("no names, or no canvas to measure them with, means no growth", () => {
  mount([]);
  expect(pop.style.maxWidth).toBe("0px");

  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
  mount([LONG]);
  expect(pop.style.maxWidth).toBe("0px");
});

test("does nothing while the picker is closed", () => {
  mount([LONG], true, false);
  expect(pop.style.maxWidth).toBe("");
});

test("outside the app's content area only the name fit caps it", () => {
  // Re-home the popover outside main; no edge to respect, no observer.
  document.body.appendChild(pop);
  mount([LONG]);
  expect(pop.style.maxWidth).toBe("468px");
  expect(resize).toBeNull();
  pop.remove();
});

function grip() {
  const g = document.createElement("div");
  g.setPointerCapture = vi.fn();
  return g;
}

function pointerDown(g: HTMLElement, clientX: number, button = 0) {
  const preventDefault = vi.fn();
  return {
    preventDefault,
    event: {
      button,
      clientX,
      pointerId: 1,
      currentTarget: g,
      preventDefault,
    } as unknown as ReactPointerEvent<HTMLElement>,
  };
}

test("dragging a grip moves the right edge, held between min and max", () => {
  const { result } = mount([LONG]); // max 468, min 260, now 300 wide
  const g = grip();
  const down = pointerDown(g, 500);
  result.current(down.event);
  expect(down.preventDefault).toHaveBeenCalled();
  expect(g.setPointerCapture).toHaveBeenCalledWith(1);

  const move = (x: number) =>
    g.dispatchEvent(new MouseEvent("pointermove", { clientX: x }));
  move(550);
  expect(pop.style.width).toBe("350px");
  move(900); // past the max
  expect(pop.style.width).toBe("468px");
  move(100); // past the min
  expect(pop.style.width).toBe("260px");

  // Letting go ends the drag.
  g.dispatchEvent(new Event("lostpointercapture"));
  move(550);
  expect(pop.style.width).toBe("260px");
});

test("only a primary-button press starts a drag", () => {
  const { result } = mount([LONG]);
  const g = grip();
  const down = pointerDown(g, 500, 2);
  result.current(down.event);
  expect(g.setPointerCapture).not.toHaveBeenCalled();
  g.dispatchEvent(new MouseEvent("pointermove", { clientX: 550 }));
  expect(pop.style.width).toBe("");
});

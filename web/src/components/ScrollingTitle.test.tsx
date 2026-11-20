import { act, render } from "@testing-library/react";
import { ScrollingTitle } from "./ScrollingTitle";

// A truncated label scrolls its full text on hover. Whether it's truncated,
// how far to slide and for how long are measured here and written onto the
// clip box for the CSS animation. jsdom has no layout, so the two boxes'
// widths are stubbed, and the ResizeObserver fires as a browser's does: once
// on observe and again on each resize.

let textWidth = 0;
let boxWidth = 0;
let observers: Array<() => void> = [];
const realRO = globalThis.ResizeObserver;
const realRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = class {
    constructor(private cb: () => void) {}
    observe() {
      observers.push(this.cb);
      this.cb();
    }
    unobserve() {}
    disconnect() {
      observers = observers.filter((cb) => cb !== this.cb);
    }
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const width = this.classList.contains("scrolling-title-text")
      ? textWidth
      : boxWidth;
    return { width } as DOMRect;
  };
});

afterEach(() => {
  globalThis.ResizeObserver = realRO;
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

const clip = (c: HTMLElement) => c.querySelector<HTMLElement>(".scrolling-title")!;
const prop = (el: HTMLElement, name: string) => el.style.getPropertyValue(name);

test("a label that fits is left alone", () => {
  textWidth = 100;
  boxWidth = 120;
  const { container } = render(<ScrollingTitle>exposure_time</ScrollingTitle>);
  expect(clip(container).dataset.overflow).toBeUndefined();
  expect(prop(clip(container), "--scroll-by")).toBe("");
});

test("a truncated label scrolls by its overflow at a steady pace", () => {
  textWidth = 200;
  boxWidth = 120;
  const { container } = render(
    <ScrollingTitle title="full name">a_long_column_name</ScrollingTitle>,
  );
  const el = clip(container);
  expect(el.dataset.overflow).toBe("");
  expect(el.title).toBe("full name");
  // 80px at 80px/s is a 1s travel, plus the 0.25s start and 0.5s end holds.
  expect(prop(el, "--scroll-by")).toBe("-80px");
  expect(prop(el, "--scroll-time")).toBe("1.750s");
  // The easing holds flat through the start pause (0.25 of 1.75s = 14.29%),
  // reaches the end at 1.25s (71.43%) and stays there.
  const ease = prop(el, "--scroll-ease");
  expect(ease.startsWith("linear(0, 0 14.29%, ")).toBe(true);
  expect(ease.endsWith(", 1 71.43%, 1)")).toBe(true);
});

test("a tiny overflow still takes the minimum travel time, not a twitch", () => {
  textWidth = 124;
  boxWidth = 120;
  const { container } = render(<ScrollingTitle>abc</ScrollingTitle>);
  // 4px would be 0.05s; the floor is 0.3s.
  expect(prop(clip(container), "--scroll-time")).toBe("1.050s");
});

test("a resize re-measures: a label that comes to fit stops scrolling", () => {
  textWidth = 200;
  boxWidth = 120;
  const { container } = render(<ScrollingTitle>name</ScrollingTitle>);
  expect(clip(container).dataset.overflow).toBe("");

  boxWidth = 240;
  act(() => observers.forEach((cb) => cb()));
  expect(clip(container).dataset.overflow).toBeUndefined();
});

test("extra classes join the base class", () => {
  textWidth = boxWidth = 10;
  const { container } = render(
    <ScrollingTitle className="picker-name">x</ScrollingTitle>,
  );
  expect(clip(container).className).toBe("scrolling-title picker-name");
});

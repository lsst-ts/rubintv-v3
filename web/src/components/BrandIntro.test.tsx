import { act, fireEvent, render, screen } from "@testing-library/react";
import { BrandIntro } from "./BrandIntro";

// The intro's clock is requestAnimationFrame. The tests hold each requested
// frame and hand it a timestamp themselves, so nothing here waits on real
// time. test-setup's matchMedia stub asks for reduced motion; allowMotion()
// lifts that for the tests that want the intro to run.
let frames: FrameRequestCallback[] = [];
let cancelled: number[] = [];

beforeEach(() => {
  sessionStorage.clear();
  frames = [];
  cancelled = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    cancelled.push(id);
  });
});
afterEach(() => vi.restoreAllMocks());

function allowMotion() {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: false,
  } as MediaQueryList);
}

// Run the one pending frame as if the browser's clock read `ms`.
function step(ms: number) {
  const cb = frames.shift()!;
  act(() => cb(ms));
}

const trails = () => document.querySelectorAll(".bi-trail").length;
const lines = () => document.querySelectorAll(".bi-line").length;
const wordOpacity = () =>
  document.querySelector(".bi-word")!.getAttribute("opacity");

test("with reduced motion the logo is simply there", () => {
  render(<BrandIntro />);
  const logo = screen.getByRole("img", { name: "RubinTV" });
  expect(logo.textContent).toBe("RubinTV");
  // The finished television: its outline drawn, its name showing, the Rubin
  // mark's trails gone — and no clock running.
  expect(trails()).toBe(0);
  expect(lines()).toBe(7);
  expect(wordOpacity()).toBe("1");
  expect(frames).toHaveLength(0);
});

test("the first time, it arrives as the Rubin mark and becomes the television", () => {
  allowMotion();
  render(<BrandIntro />);
  // The Rubin mark: all seven trails, no outline, no name.
  expect(trails()).toBe(7);
  expect(lines()).toBe(0);
  expect(wordOpacity()).toBe("0");

  // The first frame only sets the clock's zero.
  step(1000);
  expect(trails()).toBe(7);
  // 1.9 s in: the trails have gone and the outline has begun.
  step(2900);
  expect(trails()).toBe(0);
  expect(lines()).toBeGreaterThan(0);
  expect(lines()).toBeLessThan(7);
  // Past the end: the television, and the clock stops asking for frames.
  step(9000);
  expect(lines()).toBe(7);
  expect(wordOpacity()).toBe("1");
  expect(frames).toHaveLength(0);
});

test("coming back to it in the same tab shows it finished", () => {
  allowMotion();
  const first = render(<BrandIntro />);
  expect(frames).toHaveLength(1);
  // Leaving mid-intro stops its clock.
  first.unmount();
  expect(cancelled).toEqual([1]);

  render(<BrandIntro />);
  expect(frames).toHaveLength(1);
  expect(trails()).toBe(0);
  expect(lines()).toBe(7);
});

test("clicking the logo plays the intro again", () => {
  render(<BrandIntro />);
  expect(lines()).toBe(7);
  fireEvent.click(screen.getByRole("img", { name: "RubinTV" }));
  expect(trails()).toBe(7);
  expect(lines()).toBe(0);
  expect(frames).toHaveLength(1);
});

test("with storage blocked it just plays every time", () => {
  allowMotion();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(<BrandIntro />);
  expect(trails()).toBe(7);
  expect(frames).toHaveLength(1);
});

test("a browser with no matchMedia gets the intro", () => {
  const matchMedia = window.matchMedia;
  // @ts-expect-error -- standing in for a browser that lacks it
  window.matchMedia = undefined;
  try {
    render(<BrandIntro />);
    expect(trails()).toBe(7);
  } finally {
    window.matchMedia = matchMedia;
  }
});

test("a paused intro waits on the Rubin mark until it's let go", () => {
  allowMotion();
  const view = render(<BrandIntro paused />);
  expect(trails()).toBe(7);
  expect(frames).toHaveLength(0);
  // Nor does it count as played: the page that takes over may play it.
  expect(sessionStorage.length).toBe(0);

  view.rerender(<BrandIntro />);
  expect(frames).toHaveLength(1);
  expect(sessionStorage.length).toBe(1);
});

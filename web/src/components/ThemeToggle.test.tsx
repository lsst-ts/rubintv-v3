import { act, fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "./ThemeToggle";

// The theme picker and the useTheme hook behind it: the chosen mode is saved,
// applied to <html data-theme>, and in "system" mode follows the OS setting
// live. Storage can be unavailable (private mode), which must never break it.

const KEY = "rubintv-theme";
const realMatchMedia = window.matchMedia;

// A controllable prefers-color-scheme query: `setDark` flips the OS setting and
// notifies whoever is listening, as a real MediaQueryList does.
function stubOsTheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
  return {
    listeners,
    setDark(next: boolean) {
      mq.matches = next;
      listeners.forEach((fn) => fn());
    },
  };
}

const theme = () => document.documentElement.getAttribute("data-theme");
const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

test("with nothing saved it follows the system, which defaults to light", () => {
  render(<ThemeToggle />);
  expect(pressed("System theme")).toBe("true");
  expect(pressed("Light theme")).toBe("false");
  expect(theme()).toBe("light");
});

test("picking a theme applies it and remembers it for the next visit", () => {
  const { unmount } = render(<ThemeToggle />);
  fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
  expect(theme()).toBe("dark");
  expect(pressed("Dark theme")).toBe("true");
  expect(localStorage.getItem(KEY)).toBe("dark");
  unmount();

  // A fresh mount (next page load) starts from the saved choice.
  document.documentElement.removeAttribute("data-theme");
  render(<ThemeToggle />);
  expect(pressed("Dark theme")).toBe("true");
  expect(theme()).toBe("dark");
});

test("an unrecognised saved value falls back to the system theme", () => {
  localStorage.setItem(KEY, "sepia");
  render(<ThemeToggle />);
  expect(pressed("System theme")).toBe("true");
});

test("system mode resolves the OS dark setting and tracks it live", () => {
  const os = stubOsTheme(true);
  render(<ThemeToggle />);
  expect(theme()).toBe("dark");

  act(() => os.setDark(false));
  expect(theme()).toBe("light");
  act(() => os.setDark(true));
  expect(theme()).toBe("dark");
});

test("an explicit choice stops following the OS", () => {
  const os = stubOsTheme(false);
  render(<ThemeToggle />);
  expect(os.listeners.size).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
  expect(os.listeners.size).toBe(0);
  act(() => os.setDark(true));
  expect(theme()).toBe("light");
});

test("without matchMedia the system theme is light", () => {
  // @ts-expect-error - simulating an engine without matchMedia.
  window.matchMedia = undefined;
  render(<ThemeToggle />);
  expect(theme()).toBe("light");
});

test("blocked storage neither breaks reading nor choosing a theme", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(<ThemeToggle />);
  expect(pressed("System theme")).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
  expect(theme()).toBe("dark");
  expect(pressed("Dark theme")).toBe("true");
});

test("the vertical variant stacks the same three choices", () => {
  render(<ThemeToggle vertical />);
  const group = screen.getByRole("group", { name: "Color theme" });
  expect(group.className).toContain("vertical");
  expect(screen.getAllByRole("button")).toHaveLength(3);
});

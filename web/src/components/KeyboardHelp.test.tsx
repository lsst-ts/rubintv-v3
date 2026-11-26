import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { openKeyboardHelp } from "../lib/keyboardHelp";
import { KeyboardHelp } from "./KeyboardHelp";

// The keyboard-shortcuts panel: ? toggles it, the NavMenu's entry opens it,
// and it leads with the groups the current page answers.

// A key goes to whatever has focus and bubbles up to the window, as a real
// press does.
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
const panel = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });
const headings = () =>
  screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

test("? opens the panel and closes it again, as does Esc", () => {
  render(<KeyboardHelp here={["anywhere"]} />);
  expect(panel()).toBeNull();
  expect(press("?", { shiftKey: true })).toBe(false);
  expect(panel()).not.toBeNull();
  press("?", { shiftKey: true });
  expect(panel()).toBeNull();

  press("?");
  press("Escape");
  expect(panel()).toBeNull();
});

test("a ? typed into a text field is text, not the panel", () => {
  render(
    <>
      <input aria-label="search" />
      <KeyboardHelp here={["anywhere"]} />
    </>,
  );
  screen.getByLabelText("search").focus();
  expect(press("?")).toBe(true);
  expect(panel()).toBeNull();
});

test("the menu's entry opens it", () => {
  render(<KeyboardHelp here={["anywhere"]} />);
  act(() => openKeyboardHelp());
  expect(panel()).not.toBeNull();
});

test("the page's own groups come first, marked as this page's", () => {
  render(<KeyboardHelp here={["anywhere", "days", "channel"]} />);
  press("?");
  expect(headings()).toEqual([
    "Anywhere",
    "Pages with a datethis page",
    "Channel viewerthis page",
    "Camera table",
  ]);
  // Each shortcut is its keys and what they do.
  const row = screen.getByText("Previous channel for this exposure");
  const keys = row.previousElementSibling!.querySelectorAll("kbd");
  expect([...keys].map((k) => k.textContent)).toEqual(["Shift", "←"]);
});

test("focus moves into the panel, and back where it was when it closes", () => {
  render(
    <>
      <button type="button">before</button>
      <KeyboardHelp here={["anywhere"]} />
    </>,
  );
  const before = screen.getByRole("button", { name: "before" });
  before.focus();
  press("?");
  expect(document.activeElement).toBe(panel());
  press("Escape");
  expect(document.activeElement).toBe(before);
});

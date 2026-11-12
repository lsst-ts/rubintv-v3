import { afterEach, expect, test } from "vitest";
import {
  ariaKeys,
  comboKeys,
  keyHint,
  pageKeysPaused,
  pressed,
  shownCombos,
  typingInField,
} from "./shortcuts";

// The one list of shortcuts, and how a key press is matched against it.

const key = (k: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: k, ...init });

afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(navigator, "platform");
});

test("a printable key matches on its character, whatever it took to type", () => {
  // ? takes Shift on most layouts, [ takes Option on some.
  expect(pressed(key("?", { shiftKey: true }), "help")).toBe(true);
  expect(pressed(key("[", { altKey: true }), "prevDay")).toBe(true);
  // ⌘[ is the browser's Back, and Ctrl is never part of typing it.
  expect(pressed(key("[", { metaKey: true }), "prevDay")).toBe(false);
  expect(pressed(key("[", { ctrlKey: true }), "prevDay")).toBe(false);
});

test("a named key must match its modifiers", () => {
  expect(pressed(key(" "), "pageDown")).toBe(true);
  expect(pressed(key(" ", { shiftKey: true }), "pageDown")).toBe(false);
  expect(pressed(key(" ", { shiftKey: true }), "pageUp")).toBe(true);
  // ⌘↑ is the top, not a row; Shift doesn't matter to a row.
  expect(pressed(key("ArrowUp", { metaKey: true }), "top")).toBe(true);
  expect(pressed(key("ArrowUp", { metaKey: true }), "rowUp")).toBe(false);
  expect(pressed(key("ArrowUp", { shiftKey: true }), "rowUp")).toBe(true);
  // Shift picks the channel over the exposure.
  expect(pressed(key("ArrowLeft", { shiftKey: true }), "prevChannel")).toBe(true);
  expect(pressed(key("ArrowLeft", { shiftKey: true }), "prevExposure")).toBe(false);
  expect(pressed(key("ArrowLeft", { altKey: true }), "prevExposure")).toBe(false);
  expect(pressed(key("Escape", { shiftKey: true }), "close")).toBe(true);
});

test("a text field takes printable keys; a checkbox doesn't", () => {
  expect(typingInField()).toBe(false);
  const field = document.createElement("input");
  const box = Object.assign(document.createElement("input"), {
    type: "checkbox",
  });
  document.body.append(field, box);
  field.focus();
  expect(typingInField()).toBe(true);
  box.focus();
  expect(typingInField()).toBe(false);
  // Nor does a focused drawing.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("tabindex", "0");
  document.body.append(svg);
  svg.focus();
  expect(document.activeElement).toBe(svg);
  expect(typingInField()).toBe(false);
});

test("the page's keys pause under a modal", () => {
  expect(pageKeysPaused()).toBe(false);
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  expect(pageKeysPaused()).toBe(true);
});

test("tooltip hints and aria-keyshortcuts name the keys", () => {
  expect(keyHint("prevChannel")).toBe("Shift ←");
  expect(keyHint("addFilter")).toBe("/");
  expect(ariaKeys("pageUp")).toBe("PageUp Shift+Space");
});

test("⌘ combos are shown on a Mac only", () => {
  Object.defineProperty(navigator, "platform", {
    value: "Linux x86_64",
    configurable: true,
  });
  expect(shownCombos("top").map((c) => c.key)).toEqual(["Home"]);
  expect(ariaKeys("top")).toBe("Home");
  Object.defineProperty(navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
  expect(ariaKeys("top")).toBe("Home Meta+ArrowUp");
  expect(comboKeys(shownCombos("top")[1])).toEqual(["⌘", "↑"]);
});

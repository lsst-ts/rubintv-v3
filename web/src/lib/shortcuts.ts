// Every keyboard shortcut, in one list. The help panel (press ?) shows it, and
// the handlers match key presses against it, so the panel can't describe a
// key that does something else.

export interface Combo {
  // KeyboardEvent.key.
  key: string;
  // Must Shift be held (true), not held (false), or either (undefined)?
  // Printable keys ignore it: see `pressed`.
  shift?: boolean;
  // ⌘ held. macOS only; the panel leaves these out elsewhere.
  meta?: boolean;
}

export interface Shortcut {
  // Alternatives: any one of them does it.
  combos: Combo[];
  does: string;
}

const DEFS = {
  help: { combos: [{ key: "?" }], does: "Show or hide these shortcuts" },
  close: {
    combos: [{ key: "Escape" }],
    does: "Close a pop-up (date picker, menu, filter, cell details) or this panel",
  },
  prevDay: {
    combos: [{ key: "[" }],
    does: "Previous day with data (on a movie channel, night with a movie)",
  },
  nextDay: { combos: [{ key: "]" }], does: "Next day with data (or night)" },
  addFilter: {
    combos: [{ key: "/" }],
    does: "Add a filter: type to search the columns, ↑ ↓ and Enter to pick",
  },
  rowUp: { combos: [{ key: "ArrowUp" }], does: "Scroll up a row" },
  rowDown: { combos: [{ key: "ArrowDown" }], does: "Scroll down a row" },
  pageUp: {
    combos: [{ key: "PageUp" }, { key: " ", shift: true }],
    does: "Scroll up a page",
  },
  pageDown: {
    combos: [{ key: "PageDown" }, { key: " ", shift: false }],
    does: "Scroll down a page",
  },
  top: {
    combos: [{ key: "Home" }, { key: "ArrowUp", meta: true }],
    does: "Jump to the top",
  },
  bottom: {
    combos: [{ key: "End" }, { key: "ArrowDown", meta: true }],
    does: "Jump to the bottom",
  },
  prevExposure: {
    combos: [{ key: "ArrowLeft", shift: false }],
    does: "Previous exposure",
  },
  nextExposure: {
    combos: [{ key: "ArrowRight", shift: false }],
    does: "Next exposure",
  },
  prevChannel: {
    combos: [{ key: "ArrowLeft", shift: true }],
    does: "Previous channel for this exposure",
  },
  nextChannel: {
    combos: [{ key: "ArrowRight", shift: true }],
    does: "Next channel for this exposure",
  },
} satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof DEFS;

export const SHORTCUTS: Record<ShortcutId, Shortcut> = DEFS;

// Where shortcuts apply, so the panel can lead with the ones this page has.
export type Scope = "anywhere" | "days" | "table" | "channel";

export interface ShortcutGroup {
  scope: Scope;
  title: string;
  ids: ShortcutId[];
}

export const GROUPS: ShortcutGroup[] = [
  { scope: "anywhere", title: "Anywhere", ids: ["help", "close"] },
  { scope: "days", title: "Pages with a date", ids: ["prevDay", "nextDay"] },
  {
    scope: "table",
    title: "Camera table",
    ids: ["addFilter", "rowUp", "rowDown", "pageUp", "pageDown", "top", "bottom"],
  },
  {
    scope: "channel",
    title: "Channel viewer",
    ids: ["prevExposure", "nextExposure", "prevChannel", "nextChannel"],
  },
];

// A printable key is matched on the character alone: "?" takes Shift on most
// layouts and "[" takes Option or AltGr on some, so those are part of typing
// it. ⌘ and Ctrl never are (⌘[ is the browser's Back), bar AltGr, which
// Windows reports as Ctrl+Alt. A named key (arrows, Page Up, Space …) must
// match its modifiers exactly, Shift aside where the combo leaves it open.
const isChar = (key: string) => key.length === 1 && key !== " ";

function comboMatches(e: KeyboardEvent, c: Combo): boolean {
  if (e.key !== c.key) return false;
  if (isChar(c.key)) {
    return !e.metaKey && (!e.ctrlKey || e.getModifierState("AltGraph"));
  }
  return (
    !e.ctrlKey &&
    !e.altKey &&
    e.metaKey === !!c.meta &&
    (c.shift === undefined || e.shiftKey === c.shift)
  );
}

export function pressed(e: KeyboardEvent, id: ShortcutId): boolean {
  return SHORTCUTS[id].combos.some((c) => comboMatches(e, c));
}

// Whether focus is in a text field, which takes every printable key: a "/" or
// "[" typed into a filter is text, not a shortcut.
export function typingInField(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable ||
    el.matches(
      'textarea, select, input:not([type="checkbox"]):not([type="radio"]):not([type="button"])',
    )
  );
}

// Whether the page's shortcuts should stand down: focus is in a text field, or
// a modal (this panel, a cell's details) is up over the page.
export function pageKeysPaused(): boolean {
  return typingInField() || document.querySelector('[aria-modal="true"]') !== null;
}

export const isMac = () =>
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const KEY_NAMES: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
  PageUp: "Page Up",
  PageDown: "Page Down",
  Escape: "Esc",
};

// A combo as the keys to press, e.g. ["Shift", "←"].
export function comboKeys(c: Combo): string[] {
  return [
    ...(c.meta ? ["⌘"] : []),
    ...(c.shift ? ["Shift"] : []),
    KEY_NAMES[c.key] ?? c.key,
  ];
}

// The combos the panel shows on this platform.
export function shownCombos(id: ShortcutId): Combo[] {
  const mac = isMac();
  return SHORTCUTS[id].combos.filter((c) => mac || !c.meta);
}

// A shortcut's first combo, for a control's tooltip: "Next exposure (→)".
export function keyHint(id: ShortcutId): string {
  return comboKeys(SHORTCUTS[id].combos[0]).join(" ");
}

// The aria-keyshortcuts value for a control that a shortcut also works.
export function ariaKeys(id: ShortcutId): string {
  return shownCombos(id)
    .map((c) =>
      [
        ...(c.meta ? ["Meta"] : []),
        ...(c.shift ? ["Shift"] : []),
        c.key === " " ? "Space" : c.key,
      ].join("+"),
    )
    .join(" ");
}

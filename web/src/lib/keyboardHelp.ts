// The NavMenu's "Keyboard shortcuts" entry asks the shell's panel to open with
// a window event. The panel already listens on the window for ?, and the menu
// is drawn in two places (the topbar, and Home's own), so an event reaches the
// panel from either without threading a callback through the router.
const OPEN = "rubintv:keyboard-help";

export function openKeyboardHelp(): void {
  window.dispatchEvent(new Event(OPEN));
}

export function onOpenKeyboardHelp(open: () => void): () => void {
  window.addEventListener(OPEN, open);
  return () => window.removeEventListener(OPEN, open);
}

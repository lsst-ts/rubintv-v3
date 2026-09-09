import { useEffect, useRef, type RefObject } from "react";

// A stack of the currently-active Escape dismissers, most-recently-activated
// last. Escape dismisses only the top one, so stacked overlays (e.g. a
// CellModal opened above the column picker) close one at a time instead of all
// at once. Module-level so every useDismiss instance shares it.
const escapeStack: Array<() => void> = [];

// Calls `onDismiss` when the user clicks/taps outside `ref` or presses Escape,
// while `active` is true. For popovers (column picker, date picker, filters)
// that should close on an outside interaction. Listens in the capture phase so
// it fires before inner handlers, and ignores the pointer event that opened the
// popover (only pointerdowns after mount dismiss).
export function useDismiss(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  // Callers pass inline arrows, so `onDismiss` changes identity every render.
  // Keep the latest in a ref and register a stable wrapper: if the effect
  // depended on `onDismiss`, every re-render would pop and re-push the stack
  // entry — and child-first effect re-runs would invert the stack order, so
  // Escape would dismiss a parent overlay above its nested child.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });
  useEffect(() => {
    if (!active) return;
    const dismiss = () => onDismissRef.current();
    const onPointerDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        dismiss();
      }
    };
    // Register on a stack; Escape only fires the topmost dismisser so nested
    // overlays close one level per keypress.
    const entry = dismiss;
    escapeStack.push(entry);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escapeStack[escapeStack.length - 1] === entry) {
        e.stopPropagation();
        dismiss();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      const i = escapeStack.indexOf(entry);
      if (i !== -1) escapeStack.splice(i, 1);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, ref]);
}

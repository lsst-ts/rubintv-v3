import { useEffect, type RefObject } from "react";

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
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        onDismiss();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, ref, onDismiss]);
}

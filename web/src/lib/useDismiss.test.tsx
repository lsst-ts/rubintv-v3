import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { expect, test, vi } from "vitest";
import { useDismiss } from "./useDismiss";

function Overlay({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, ref, onDismiss);
  return <div ref={ref}>overlay{children}</div>;
}

test("Escape dismisses only the most recently opened overlay", () => {
  const first = vi.fn();
  const second = vi.fn();
  render(
    <>
      <Overlay onDismiss={first} />
      <Overlay onDismiss={second} />
    </>,
  );

  // One Escape closes only the top (second) overlay.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
});

test("Escape dismisses a single overlay", () => {
  const onDismiss = vi.fn();
  render(<Overlay onDismiss={onDismiss} />);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("re-renders don't reorder the stack: Escape still closes the innermost", () => {
  const parent = vi.fn();
  const child = vi.fn();
  // Inline-arrow onDismiss props (as real callers pass) change identity every
  // render; before the ref fix that re-ran the register effects child-first on
  // every re-render, leaving the parent overlay on top of the stack above its
  // own nested child.
  function App() {
    const [childOpen, setChildOpen] = useState(false);
    const [, setTick] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setChildOpen(true)}>
          open child
        </button>
        <button type="button" onClick={() => setTick((t) => t + 1)}>
          rerender
        </button>
        <Overlay onDismiss={() => parent()}>
          {childOpen && <Overlay onDismiss={() => child()} />}
        </Overlay>
      </>
    );
  }
  render(<App />);

  // The nested child overlay opens after the parent, so it must be on top.
  fireEvent.click(screen.getByText("open child"));
  // Force both dismissers to re-render with fresh onDismiss identities.
  fireEvent.click(screen.getByText("rerender"));

  fireEvent.keyDown(document, { key: "Escape" });
  expect(child).toHaveBeenCalledTimes(1);
  expect(parent).not.toHaveBeenCalled();
});

test("outside pointerdown dismisses", () => {
  const onDismiss = vi.fn();
  render(
    <div>
      <Overlay onDismiss={onDismiss} />
      <button type="button">outside</button>
    </div>,
  );
  fireEvent.pointerDown(document.body);
  expect(onDismiss).toHaveBeenCalled();
});

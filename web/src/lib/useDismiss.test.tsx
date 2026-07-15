import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import { useDismiss } from "./useDismiss";

function Overlay({ onDismiss }: { onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, ref, onDismiss);
  return <div ref={ref}>overlay</div>;
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

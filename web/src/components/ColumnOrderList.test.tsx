import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ColumnOrderList } from "./ColumnOrderList";

// The list's drag path is exercised end-to-end in the browser (see the
// run-rubintv verification). Under jsdom (no layout, no pointer sensor) we test
// the keyboard/click nudge path, which is the accessible reorder fallback and
// drives the same onReorder contract.

const COLS = ["Exposure time", "Image type", "Target"];

test("renders one row per visible column, in order", () => {
  render(<ColumnOrderList columns={COLS} onReorder={() => {}} />);
  const labels = screen
    .getAllByText(/Exposure time|Image type|Target/)
    .map((el) => el.textContent);
  expect(labels).toEqual(COLS);
});

test("the ↓ button moves a column one place later", () => {
  const onReorder = vi.fn();
  render(<ColumnOrderList columns={COLS} onReorder={onReorder} />);
  fireEvent.click(screen.getByLabelText("Move Exposure time down"));
  expect(onReorder).toHaveBeenCalledWith(["Image type", "Exposure time", "Target"]);
});

test("the ↑ button moves a column one place earlier", () => {
  const onReorder = vi.fn();
  render(<ColumnOrderList columns={COLS} onReorder={onReorder} />);
  fireEvent.click(screen.getByLabelText("Move Target up"));
  expect(onReorder).toHaveBeenCalledWith(["Exposure time", "Target", "Image type"]);
});

test("the first row's ↑ and last row's ↓ are disabled", () => {
  render(<ColumnOrderList columns={COLS} onReorder={() => {}} />);
  expect(
    (screen.getByLabelText("Move Exposure time up") as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText("Move Target down") as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("an empty visible set shows a placeholder, not a list", () => {
  render(<ColumnOrderList columns={[]} onReorder={() => {}} />);
  expect(screen.getByText("No columns shown.")).toBeDefined();
});

describe("keyboard drag", () => {
  // dnd-kit's keyboard sensor moves between rows by their boxes, which jsdom
  // doesn't lay out: stack the rows 30px apart so "down" has somewhere to go.
  // It measures them a beat after pick-up, so timers are faked and stepped
  // explicitly rather than waited for.
  const realRect = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const label = this.getAttribute("aria-label") ?? "";
      const i = COLS.findIndex((c) => label === `Reorder ${c}`);
      const top = i < 0 ? 0 : i * 30;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        bottom: top + 30,
        right: 200,
        width: i < 0 ? 0 : 200,
        height: i < 0 ? 0 : 30,
        toJSON() {},
      } as DOMRect;
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
    vi.useRealTimers();
  });

  const row = (c: string) => screen.getByLabelText(`Reorder ${c}`);
  const press = (el: Element, key: string, code = key) => {
    fireEvent.keyDown(el, { key, code });
    act(() => vi.advanceTimersByTime(16));
  };

  test("picking a row up, moving it down and dropping it reorders", () => {
    const onReorder = vi.fn();
    render(<ColumnOrderList columns={COLS} onReorder={onReorder} />);
    const r = row("Exposure time");
    r.focus();
    press(r, " ", "Space");
    press(r, "ArrowDown");
    press(r, " ", "Space");
    expect(onReorder).toHaveBeenCalledWith([
      "Image type",
      "Exposure time",
      "Target",
    ]);
  });

  test("dropping a row where it started changes nothing", () => {
    const onReorder = vi.fn();
    render(<ColumnOrderList columns={COLS} onReorder={onReorder} />);
    const r = row("Image type");
    r.focus();
    press(r, " ", "Space");
    press(r, " ", "Space");
    expect(onReorder).not.toHaveBeenCalled();
  });

  test("pressing a nudge button doesn't pick the row up", () => {
    const onReorder = vi.fn();
    render(<ColumnOrderList columns={COLS} onReorder={onReorder} />);
    const down = screen.getByLabelText("Move Exposure time down");
    fireEvent.pointerDown(down, { button: 0, isPrimary: true });
    fireEvent.click(down);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(row("Exposure time").className).not.toContain("dragging");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
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

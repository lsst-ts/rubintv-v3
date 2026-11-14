import { fireEvent, render, screen, within } from "@testing-library/react";
import { CellModal } from "./CellModal";

// The dialog behind a metadata cell whose value is a JSON object or array: a
// key/value table of every entry, minus DISPLAY_VALUE (only the cell button's
// label). It closes from its × button, Escape, or a click outside it.

function rows() {
  return within(screen.getByRole("dialog"))
    .getAllByRole("row")
    .map((r) => [
      r.querySelector("th")?.textContent,
      r.querySelector("td")?.textContent,
    ]);
}

test("an object's entries are listed, without DISPLAY_VALUE", () => {
  render(
    <CellModal
      header="Focus"
      data={{
        DISPLAY_VALUE: "📈",
        offset: 1.5,
        ok: true,
        note: null,
        nested: { a: [1, 2] },
      }}
      onClose={() => {}}
    />,
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(within(dialog).getByText("Focus")).toBeDefined();
  // Scalars print as-is; null and nested values print as JSON.
  expect(rows()).toEqual([
    ["offset", "1.5"],
    ["ok", "true"],
    ["note", "null"],
    ["nested", '{"a":[1,2]}'],
  ]);
});

test("an array's items are listed by index", () => {
  render(<CellModal header="Stars" data={["a", 2, { x: 1 }]} onClose={() => {}} />);
  expect(rows()).toEqual([
    ["0", "a"],
    ["1", "2"],
    ["2", '{"x":1}'],
  ]);
});

test("the dialog renders outside its trigger's container (a body portal)", () => {
  const { container } = render(
    <CellModal header="H" data={{ a: 1 }} onClose={() => {}} />,
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
});

test("the close button, Escape, and an outside click each close it", () => {
  const onClose = vi.fn();
  render(<CellModal header="H" data={{ a: 1 }} onClose={onClose} />);

  // A click inside the dialog doesn't.
  fireEvent.pointerDown(screen.getByText("a"));
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);

  fireEvent.pointerDown(document.body);
  expect(onClose).toHaveBeenCalledTimes(3);
});

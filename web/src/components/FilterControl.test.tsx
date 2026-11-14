import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { Filter } from "../lib/filters";
import { FilterBar, FilterControl } from "./FilterControl";

// The table's filter popover and chip bar on their own: the searchable,
// keyboard-driven column box, operator choices that follow the column's
// type, suggested values, and the chip bar's clear-all and row count. The
// end-to-end narrowing of table rows is in routes.test.

const METADATA = {
  "1": { Filter: "z_20", Exposure: 30, Object: "HD 1" },
  "2": { Filter: "r_03", Exposure: 15, Object: "HD 2" },
};
const COLUMNS = ["Filter", "Exposure", "Object"];

function Harness({ initial = [] as Filter[], total = 2 }) {
  const [filters, setFilters] = useState<Filter[]>(initial);
  return (
    <>
      <FilterControl
        columns={COLUMNS}
        metadata={METADATA}
        filters={filters}
        setFilters={setFilters}
      />
      <FilterBar
        columns={COLUMNS}
        metadata={METADATA}
        filters={filters}
        setFilters={setFilters}
        shown={1}
        total={total}
      />
      <output data-testid="filters">{JSON.stringify(filters)}</output>
    </>
  );
}

const applied = () =>
  JSON.parse(screen.getByTestId("filters").textContent ?? "[]") as Filter[];

function openForm() {
  fireEvent.click(screen.getByRole("button", { name: "Add or edit filters" }));
  return screen.getByRole("dialog", { name: "Add filter" });
}

const items = (form: HTMLElement) =>
  [...form.querySelectorAll(".list .item")].map((el) => ({
    name: el.querySelector(".name")!.textContent,
    active: el.className.includes("kbd-active"),
  }));

test("the column box searches, highlights, and picks from the keyboard", () => {
  render(<Harness />);
  const form = openForm();
  const combo = within(form).getByLabelText("Filter column");
  expect((combo as HTMLInputElement).value).toBe("Filter"); // the default

  fireEvent.focus(combo);
  expect(within(form).getByText("3 of 3 columns")).toBeDefined();
  fireEvent.change(combo, { target: { value: "ob" } });
  expect(items(form)).toEqual([{ name: "Object", active: true }]);
  expect(form.querySelector(".list mark")?.textContent).toBe("Ob");

  fireEvent.change(combo, { target: { value: "" } });
  fireEvent.keyDown(combo, { key: "ArrowDown" });
  fireEvent.keyDown(combo, { key: "ArrowDown" });
  fireEvent.keyDown(combo, { key: "ArrowDown" }); // stops at the last
  fireEvent.keyDown(combo, { key: "ArrowUp" });
  expect(items(form).map((i) => i.active)).toEqual([false, true, false]);
  fireEvent.keyDown(combo, { key: "Enter" });
  expect((combo as HTMLInputElement).value).toBe("Exposure");
  expect(form.querySelector(".list")).toBeNull();
});

test("hovering a column highlights it and clicking picks it", () => {
  render(<Harness />);
  const form = openForm();
  const combo = within(form).getByLabelText("Filter column");
  fireEvent.focus(combo);
  const object = within(form).getByText("Object").closest(".item")!;
  fireEvent.mouseEnter(object);
  expect(object.className).toContain("kbd-active");
  fireEvent.click(object);
  expect((combo as HTMLInputElement).value).toBe("Object");
});

test("a search with no match says so; Escape or a click away restores it", () => {
  render(<Harness />);
  const form = openForm();
  const combo = within(form).getByLabelText("Filter column") as HTMLInputElement;
  fireEvent.change(combo, { target: { value: "zzz" } });
  expect(within(form).getByText("no columns match “zzz”")).toBeDefined();
  // Enter with nothing to pick does nothing.
  fireEvent.keyDown(combo, { key: "Enter" });
  fireEvent.keyDown(combo, { key: "Escape" });
  expect(combo.value).toBe("Filter");

  fireEvent.change(combo, { target: { value: "exp" } });
  fireEvent.pointerDown(within(form).getByText("op"));
  expect(form.querySelector(".list")).toBeNull();
  expect(combo.value).toBe("Filter");
});

test("operators follow the column's type and snap when it changes", () => {
  render(<Harness />);
  const form = openForm();
  const op = within(form).getByLabelText("Operator") as HTMLSelectElement;
  // Filter is a string column: string operators.
  expect(within(op).getByRole("option", { name: "contains" })).toBeDefined();
  fireEvent.change(op, { target: { value: "~" } });

  // Exposure is numeric: "contains" doesn't exist there, so it snaps to "=".
  const combo = within(form).getByLabelText("Filter column");
  fireEvent.focus(combo);
  fireEvent.click(within(form).getByText("Exposure"));
  expect(op.value).toBe("=");
  expect(within(op).getByRole("option", { name: "≥" })).toBeDefined();

  fireEvent.change(op, { target: { value: "between" } });
  const value = within(form).getByLabelText("Filter value");
  expect(value.getAttribute("placeholder")).toBe("lo, hi");
  // A range takes no single suggested value.
  expect(within(form).queryByText("common values:")).toBeNull();
});

test("a filter added after switching column type carries the snapped operator", () => {
  // The <select> shows its first option for any value it lacks, so check
  // what's actually applied: "contains" must not survive onto a number.
  render(<Harness />);
  const form = openForm();
  fireEvent.change(within(form).getByLabelText("Operator"), {
    target: { value: "~" },
  });
  fireEvent.focus(within(form).getByLabelText("Filter column"));
  fireEvent.click(within(form).getByText("Exposure"));
  fireEvent.change(within(form).getByLabelText("Filter value"), {
    target: { value: "30" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "add filter" }));
  expect(applied()).toEqual([{ col: "Exposure", op: "=", value: "30" }]);
});

test("suggested values fill the box; for 'is one of' they accumulate", () => {
  render(<Harness />);
  const form = openForm();
  const value = within(form).getByLabelText("Filter value") as HTMLInputElement;
  expect(value.getAttribute("placeholder")).toBe("z_20");

  fireEvent.click(within(form).getByText("z_20", { selector: ".suggestion" }));
  expect(value.value).toBe("z_20");
  fireEvent.click(within(form).getByText("r_03", { selector: ".suggestion" }));
  expect(value.value).toBe("r_03"); // replaces

  fireEvent.change(within(form).getByLabelText("Operator"), {
    target: { value: "in" },
  });
  expect(value.getAttribute("placeholder")).toBe("a, b, c");
  fireEvent.change(value, { target: { value: "" } });
  fireEvent.click(within(form).getByText("z_20", { selector: ".suggestion" }));
  fireEvent.click(within(form).getByText("r_03", { selector: ".suggestion" }));
  expect(value.value).toBe("z_20, r_03");
});

test("Enter in the value box adds the filter; a blank value adds nothing", () => {
  render(<Harness />);
  const form = openForm();
  const value = () => within(form).getByLabelText("Filter value");
  fireEvent.change(value(), { target: { value: "   " } });
  fireEvent.keyDown(value(), { key: "Enter" });
  expect(applied()).toEqual([]);

  fireEvent.change(value(), { target: { value: " z_20 " } });
  fireEvent.keyDown(value(), { key: "a" });
  expect(applied()).toEqual([]);
  fireEvent.keyDown(value(), { key: "Enter" });
  expect(applied()).toEqual([{ col: "Filter", op: "=", value: "z_20" }]);
  expect(screen.queryByRole("dialog")).toBeNull();

  // The button counts the active filters.
  expect(
    screen.getByRole("button", { name: "Add or edit filters" }).textContent,
  ).toContain("1");
});

test("with several filters a 'clear all' removes them together", () => {
  render(
    <Harness
      total={1}
      initial={[
        { col: "Filter", op: "=", value: "z_20" },
        { col: "Exposure", op: ">", value: "10" },
      ]}
    />,
  );
  // One row in all: "row", not "rows".
  expect(screen.getByText("1 of 1 row")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "clear all" }));
  expect(applied()).toEqual([]);
  expect(screen.queryByText(/of 1 row/)).toBeNull();
});

test("/ opens the form with the column search in focus", () => {
  render(<Harness />);
  const button = screen.getByRole("button", { name: "Add or edit filters" });
  expect(button.getAttribute("title")).toBe("Add or edit filters (/)");
  expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(false);
  const form = screen.getByRole("dialog", { name: "Add filter" });
  const search = within(form).getByLabelText("Filter column");
  expect(document.activeElement).toBe(search);
  // The column list is open to type into.
  expect(form.querySelectorAll(".list .item")).toHaveLength(COLUMNS.length);

  // A / typed into the form's fields is text.
  const value = within(form).getByLabelText("Filter value");
  value.focus();
  expect(fireEvent.keyDown(value, { key: "/" })).toBe(true);
  expect(document.activeElement).toBe(value);
});

test("↑ ↓ scroll the column list to keep the highlighted column in view", () => {
  const columns = Array.from({ length: 20 }, (_, i) => `col${i}`);
  render(
    <FilterControl
      columns={columns}
      metadata={{}}
      filters={[]}
      setFilters={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add or edit filters" }));
  const search = screen.getByLabelText("Filter column");
  fireEvent.focus(search);
  const list = document.querySelector<HTMLElement>(".filter-combo .list")!;
  // jsdom has no layout: give the list a 22px count line, then 20px rows,
  // 160px of which show.
  const size = (el: Element, prop: string, value: number) =>
    Object.defineProperty(el, prop, { configurable: true, value });
  size(list.querySelector(".count")!, "offsetHeight", 22);
  list.querySelectorAll(".item").forEach((item, i) => {
    size(item, "offsetTop", 22 + 20 * i);
    size(item, "offsetHeight", 20);
  });
  size(list, "clientHeight", 160);
  const press = (key: string, times: number) => {
    for (let n = 0; n < times; n++) fireEvent.keyDown(search, { key });
  };
  const active = () => list.querySelector(".kbd-active")!.textContent;

  // Rows 0-5 fit under the count line; row 6 ends at 162, so the list scrolls
  // by 2 to show it whole, and on with each row after.
  press("ArrowDown", 5);
  expect(list.scrollTop).toBe(0);
  press("ArrowDown", 1);
  expect(list.scrollTop).toBe(2);
  press("ArrowDown", 4);
  expect(active()).toMatch(/^col10/);
  expect(list.scrollTop).toBe(82);
  // Going back up, the list holds still until the highlight reaches the
  // count line, then follows it to the top.
  press("ArrowUp", 5);
  expect(list.scrollTop).toBe(82);
  press("ArrowUp", 1);
  expect(list.scrollTop).toBe(80);
  press("ArrowUp", 4);
  expect(active()).toMatch(/^col0/);
  expect(list.scrollTop).toBe(0);

  // A new search starts from its first match, at the top.
  press("ArrowDown", 8);
  fireEvent.change(search, { target: { value: "col1" } });
  expect(active()).toMatch(/^col1/);
  expect(list.scrollTop).toBe(0);
});

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps } from "react";
import { SEQ_COL } from "../lib/filters";
import type { SortState } from "../lib/sort";
import { CameraDataTable } from "./CameraDataTable";

// The camera table body on its own: object-valued cells open a dialog, the
// header labels sort (by click and keyboard), and a long night renders only
// the rows in view. Column picking, filters and links are in routes.test.

const COLUMNS = [
  { key: "seq", label: "Seq.No" },
  { key: "ch:monitor", label: "monitor" },
  { key: "meta:Exposure", label: "Exposure" },
  { key: "meta:focus", label: "focus" },
  { key: "meta:stars", label: "stars" },
];

type Props = ComponentProps<typeof CameraDataTable>;

function renderTable(over: Partial<Props> = {}) {
  const props: Props = {
    columns: COLUMNS,
    seqNums: [8, 7],
    metadata: {
      "7": {
        Exposure: 30,
        focus: { DISPLAY_VALUE: "ok", offset: 1.5 },
        stars: [3, 4],
      },
      "8": { Exposure: 15, focus: { offset: 2 }, stars: [] },
    },
    payload: {
      date: "2026-04-10",
      per_day: {},
      metadata: {},
      channels: { monitor: [7] },
      extensions: {},
    } as unknown as Props["payload"],
    channelColour: { monitor: "#123" },
    sort: null,
    onSort: () => {},
    density: "regular",
    location: "local",
    camera: "auxtel",
    date: "2026-04-10",
    viewerTmpl: null,
    quicklookTmpl: null,
    copyRowTmpl: null,
    linkCtx: () => ({
      siteLocation: "local",
      controller: undefined,
      isDevInstance: false,
    }),
    ...over,
  };
  return render(
    <MemoryRouter>
      <CameraDataTable {...props} />
    </MemoryRouter>,
  );
}

const rowFor = (seq: number) =>
  screen.getByText(String(seq), { selector: "td.seq" }).closest("tr")!;

test("an object cell with a DISPLAY_VALUE opens its details in a dialog", () => {
  renderTable();
  const button = within(rowFor(7)).getByRole("button", { name: "ok" });
  fireEvent.click(button);

  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Seq Num: 7 - focus")).toBeDefined();
  expect(within(dialog).getByText("offset")).toBeDefined();
  expect(within(dialog).queryByText("DISPLAY_VALUE")).toBeNull();

  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("object and array cells without a label get a details button", () => {
  renderTable();
  const row8 = rowFor(8);
  const details = within(row8).getByRole("button", { name: "focus details" });
  expect(details.getAttribute("title")).toBe("View details");
  // Arrays too, even empty ones.
  fireEvent.click(within(rowFor(7)).getByRole("button", { name: "stars details" }));
  expect(within(screen.getByRole("dialog")).getByText("Seq Num: 7 - stars"))
    .toBeDefined();
});

test("a seq without an image in a channel shows an empty chip, not a link", () => {
  renderTable();
  expect(within(rowFor(7)).getByRole("link", { name: "monitor 7" })).toBeDefined();
  expect(within(rowFor(8)).queryByRole("link")).toBeNull();
  expect(rowFor(8).querySelector(".cell-chip.empty")).not.toBeNull();
});

test("the newest exposure is highlighted, whatever the row order", () => {
  renderTable({ seqNums: [7, 8] });
  expect(rowFor(8).className).toBe("newest");
  expect(rowFor(7).className).toBe("");
});

test("metadata labels sort by click, Enter or Space, and show the direction", () => {
  const onSort = vi.fn();
  const sort: SortState = { col: "Exposure", dir: "asc" };
  renderTable({ onSort, sort });
  const label = screen.getByRole("button", { name: /^Exposure/ });
  expect(label.getAttribute("aria-sort")).toBe("ascending");
  expect(label.textContent).toContain("▲");

  fireEvent.click(label);
  fireEvent.keyDown(label, { key: "Enter" });
  fireEvent.keyDown(label, { key: " " });
  fireEvent.keyDown(label, { key: "a" }); // not a sort key
  expect(onSort.mock.calls).toEqual([
    ["meta:Exposure"],
    ["meta:Exposure"],
    ["meta:Exposure"],
  ]);
  // Channel columns aren't sortable: plain labels.
  expect(screen.queryByRole("button", { name: /^monitor/ })).toBeNull();
});

test("the Seq.No header sorts and shows a descending arrow", () => {
  const onSort = vi.fn();
  renderTable({ onSort, sort: { col: SEQ_COL, dir: "desc" } });
  const th = screen.getByRole("columnheader", { name: /Seq\.No/ });
  expect(th.getAttribute("aria-sort")).toBe("descending");
  expect(th.textContent).toContain("▼");
  fireEvent.click(within(th).getByRole("button"));
  expect(onSort).toHaveBeenCalledWith("seq");
});

test("a long night renders only the rows in view, padding the rest", () => {
  const seqNums = Array.from({ length: 300 }, (_, i) => 300 - i);
  const { container } = renderTable({ seqNums, metadata: {} });
  const dataRows = () =>
    container.querySelectorAll("tbody tr:not([aria-hidden])").length;
  const spacers = () => container.querySelectorAll('tbody tr[aria-hidden="true"]');

  expect(dataRows()).toBeLessThan(300);
  // Only a bottom spacer while at the top.
  expect(spacers()).toHaveLength(1);
  expect(container.querySelector("td.seq")?.textContent).toBe("300");

  // Scrolled well down, the top rows give way to a spacer too.
  const wrap = container.querySelector<HTMLElement>(".table-wrap")!;
  act(() => {
    wrap.scrollTop = 5000;
    wrap.dispatchEvent(new Event("scroll"));
  });
  expect(spacers()).toHaveLength(2);
  expect(container.querySelector("td.seq")?.textContent).not.toBe("300");
});

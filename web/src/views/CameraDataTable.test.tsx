import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createRef, type ComponentProps } from "react";
import { SEQ_COL } from "../lib/filters";
import type { SortState } from "../lib/sort";
import { setAutoHideTopbar } from "../lib/prefs";
import { CameraDataTable, type TableScroll } from "./CameraDataTable";

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

function tableProps(over: Partial<Props> = {}): Props {
  return {
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
}

function renderTable(over: Partial<Props> = {}) {
  return render(
    <MemoryRouter>
      <CameraDataTable {...tableProps(over)} />
    </MemoryRouter>,
  );
}

// The virtualizer settles each scroll on a 150ms timer that outlives the
// table. Let the last one fire before the test environment is torn down,
// where it would find no window. (Timers fire in order, so this holds however
// slow the machine.)
afterAll(() => new Promise((resolve) => setTimeout(resolve, 200)));
// The NavMenu prefs (topbar auto-hide) persist in localStorage.
beforeEach(() => localStorage.clear());

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

test("the Seq.No header sorts and shows the direction", () => {
  const onSort = vi.fn();
  const { unmount } = renderTable({ onSort, sort: { col: SEQ_COL, dir: "desc" } });
  let th = screen.getByRole("columnheader", { name: /Seq\.No/ });
  expect(th.getAttribute("aria-sort")).toBe("descending");
  expect(th.textContent).toContain("▼");
  fireEvent.click(within(th).getByRole("button"));
  expect(onSort).toHaveBeenCalledWith("seq");
  unmount();

  renderTable({ sort: { col: SEQ_COL, dir: "asc" } });
  th = screen.getByRole("columnheader", { name: /Seq\.No/ });
  expect(th.getAttribute("aria-sort")).toBe("ascending");
  expect(th.textContent).toContain("▲");
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

// Scrolled down, the table hides the shell's topbar: it flags its scroll box
// data-hide-topbar, which the CSS keys on. jsdom has no layout, so each test
// sets the scroll box's geometry and the topbar height Layout would publish.
function scrollBox(
  container: HTMLElement,
  { scrollHeight = 4000, topbarH = "120px" } = {},
) {
  const wrap = container.querySelector<HTMLElement>(".table-wrap")!;
  if (topbarH) wrap.style.setProperty("--topbar-h", topbarH);
  Object.defineProperty(wrap, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(wrap, "clientHeight", { configurable: true, value: 600 });
  const scrollTo = (top: number) =>
    act(() => {
      wrap.scrollTop = top;
      wrap.dispatchEvent(new Event("scroll"));
    });
  const hidden = () => wrap.hasAttribute("data-hide-topbar");
  return { wrap, scrollTo, hidden };
}

test("scrolling down hides the topbar until back at the very top", () => {
  const { container } = renderTable();
  const { scrollTo, hidden } = scrollBox(container);

  scrollTo(20); // a nudge isn't enough
  expect(hidden()).toBe(false);
  scrollTo(100);
  expect(hidden()).toBe(true);
  scrollTo(10); // easing back up a little keeps it hidden
  expect(hidden()).toBe(true);
  scrollTo(0);
  expect(hidden()).toBe(false);
});

test("the topbar stays when hiding it would use up the scroll range", () => {
  // 700 - 600 = 100px of scroll: hiding a 120px topbar grows the box past the
  // content, which would clamp the scroll to the top and bring it back.
  const { container } = renderTable();
  const { scrollTo, hidden } = scrollBox(container, { scrollHeight: 700 });
  scrollTo(80);
  expect(hidden()).toBe(false);
});

test("the topbar stays until its height is measured", () => {
  const { container } = renderTable();
  const { scrollTo, hidden } = scrollBox(container, { topbarH: "" });
  scrollTo(100);
  expect(hidden()).toBe(false);
});

test("the NavMenu's auto-hide switch: off brings the topbar back and keeps it", () => {
  const { container } = renderTable();
  const { scrollTo, hidden } = scrollBox(container);
  scrollTo(100);
  expect(hidden()).toBe(true);

  act(() => setAutoHideTopbar(false));
  expect(hidden()).toBe(false);
  scrollTo(200);
  expect(hidden()).toBe(false);

  // Switched back on (from a menu open in the topbar), it waits for the next
  // scroll rather than hiding the topbar under the pointer.
  act(() => setAutoHideTopbar(true));
  expect(hidden()).toBe(false);
  scrollTo(210);
  expect(hidden()).toBe(true);
});

test("a table cut short at the top brings the topbar back", () => {
  // A filter that leaves too few rows to scroll clamps the box to the top
  // without a scroll event; the height change alone must restore the topbar.
  const seqNums = Array.from({ length: 300 }, (_, i) => 300 - i);
  const { container, rerender } = renderTable({ seqNums, metadata: {} });
  const { wrap, scrollTo, hidden } = scrollBox(container);
  scrollTo(100);
  expect(hidden()).toBe(true);

  wrap.scrollTop = 0;
  rerender(
    <MemoryRouter>
      <CameraDataTable {...tableProps({ seqNums: [3, 2, 1], metadata: {} })} />
    </MemoryRouter>,
  );
  expect(hidden()).toBe(false);
});

test("it reports reaching each end, and jumps to either", () => {
  const onEdgesChange = vi.fn();
  const ref = createRef<TableScroll>();
  const { container } = renderTable({ onEdgesChange, ref });
  const { wrap, scrollTo } = scrollBox(container);
  const edges = () => onEdgesChange.mock.lastCall?.[0];

  scrollTo(0);
  expect(edges()).toEqual({ atTop: true, atBottom: false });
  scrollTo(1000);
  expect(edges()).toEqual({ atTop: false, atBottom: false });

  act(() => ref.current!.jumpTo("bottom"));
  expect(wrap.scrollTop).toBe(4000);
  // jsdom raises no scroll event for a scroll set in code; a browser does.
  act(() => {
    wrap.dispatchEvent(new Event("scroll"));
  });
  expect(edges()).toEqual({ atTop: false, atBottom: true });

  act(() => ref.current!.jumpTo("top"));
  expect(wrap.scrollTop).toBe(0);
});

// Scroll keys reach the table from anywhere on the page, not only once a cell
// has been clicked, and without moving focus.
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });

test("the scroll keys page the table by its rows, with nothing focused", () => {
  // A long night, so there are rows to page through. jsdom rows measure 36px
  // (test-setup), and the box shows 600 - 150 (the sticky header) = 450px of
  // them: rows 0-11 whole, row 12 (432-468) cut off at the bottom edge.
  const seqNums = Array.from({ length: 300 }, (_, i) => 300 - i);
  const { container } = renderTable({ seqNums, metadata: {} });
  const { wrap } = scrollBox(container);
  Object.defineProperty(container.querySelector("thead")!, "offsetHeight", {
    configurable: true,
    value: 150,
  });
  const steps: [string, KeyboardEventInit, number][] = [
    // The cut-off row 12 comes to the top; then row 24 (864-900), likewise.
    ["PageDown", {}, 432],
    [" ", {}, 864],
    // Row 24, at the top, goes to the bottom: 900 - 450.
    [" ", { shiftKey: true }, 450],
    // And back: row 24, now the bottom row, returns to the top.
    ["PageDown", {}, 864],
    ["ArrowDown", {}, 903], // a row (39, the regular estimate)
    ["ArrowUp", {}, 864],
    ["Home", {}, 0],
    ["PageUp", {}, 0], // held at the top
    ["End", {}, 3400], // 4000 - 600
    ["PageDown", {}, 3400], // and at the bottom
    ["ArrowUp", { metaKey: true }, 0], // ⌘↑ / ⌘↓ on macOS
    ["ArrowDown", { metaKey: true }, 3400],
  ];
  for (const [key, init, top] of steps) {
    press(key, init);
    expect([key, init, wrap.scrollTop]).toEqual([key, init, top]);
  }
  expect(document.activeElement).toBe(document.body);
});

test("keys that aren't for scrolling, or are taken, leave the table be", () => {
  const { container } = renderTable();
  const { wrap } = scrollBox(container);
  const unmoved = () => expect(wrap.scrollTop).toBe(0);

  press("a");
  press("ArrowLeft", { metaKey: true });
  press("PageDown", { ctrlKey: true }); // the browser's next tab
  unmoved();

  // Already handled by something on the way up.
  const claim = (e: Event) => e.preventDefault();
  document.body.addEventListener("keydown", claim);
  press("PageDown");
  document.body.removeEventListener("keydown", claim);
  unmoved();
});

test("keys stay with a focused field, popup or other scroll box", () => {
  const { container } = renderTable();
  const { wrap } = scrollBox(container);
  const focusIn = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    host.querySelector<HTMLElement>("[data-focus]")!.focus();
    return host;
  };

  const field = focusIn('<input data-focus value="x" />');
  press("Home");
  press("End");
  field.remove();
  const popup = focusIn('<div role="dialog"><button data-focus>ok</button></div>');
  press("PageDown");
  popup.remove();
  const list = focusIn(
    '<div style="overflow-y: auto"><button data-focus>pick</button></div>',
  );
  const box = list.firstElementChild!;
  Object.defineProperty(box, "scrollHeight", { value: 500 });
  Object.defineProperty(box, "clientHeight", { value: 100 });
  press("PageDown");
  list.remove();
  expect(wrap.scrollTop).toBe(0);
});

test("a focused control keeps Space but passes on the page keys", () => {
  const { container } = renderTable();
  const { wrap } = scrollBox(container);
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();

  press(" ");
  expect(wrap.scrollTop).toBe(0);
  press("PageDown");
  expect(wrap.scrollTop).toBeGreaterThan(0);
  button.remove();
});

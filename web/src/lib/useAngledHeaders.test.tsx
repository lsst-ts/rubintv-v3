import { act, render, screen } from "@testing-library/react";
import { useAngledHeaders } from "./useAngledHeaders";

// Angled header labels sit in an overlay positioned from each <th>'s measured
// offset, relative to the scroll content so the overlay scrolls with the
// table. jsdom has no layout, so the cells' boxes are stubbed.

const lefts = new Map<string, number>();
let wrapLeft = 50;
const realRect = HTMLElement.prototype.getBoundingClientRect;
const realOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
)!;
let tableWidth = 400;

beforeEach(() => {
  lefts.clear();
  lefts.set("a", 60).set("b", 140);
  wrapLeft = 50;
  tableWidth = 400;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.dataset.wrap !== undefined) return { left: wrapLeft } as DOMRect;
    const left = lefts.get(this.textContent ?? "") ?? 0;
    return { left, width: 80 } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("data-table") ? tableWidth : 0;
    },
  });
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", realOffsetWidth);
});

function Probe({
  enabled,
  cols = ["a", "b"],
  table = true,
}: {
  enabled: boolean;
  cols?: string[];
  table?: boolean;
}) {
  const { wrapRef, headRef, positions, tableWidth } = useAngledHeaders(
    enabled,
    [cols.join()],
  );
  return (
    <div ref={wrapRef} data-wrap="">
      <table className={table ? "data-table" : undefined}>
        <thead ref={headRef}>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
      </table>
      <output>
        {JSON.stringify({ positions, tableWidth })}
      </output>
    </div>
  );
}

const measured = () =>
  JSON.parse(screen.getByRole("status").textContent ?? "{}") as {
    positions: { left: number; width: number }[];
    tableWidth: number;
  };

test("measures each header cell relative to the scroll content", () => {
  render(<Probe enabled />);
  expect(measured()).toEqual({
    positions: [
      { left: 10, width: 80 },
      { left: 90, width: 80 },
    ],
    tableWidth: 400,
  });
});

test("horizontal scrolling keeps offsets in content coordinates", () => {
  const { container } = render(<Probe enabled />);
  const wrap = container.querySelector<HTMLElement>("[data-wrap]")!;
  // Scrolled 30px: the cells' screen positions move left by 30, scrollLeft
  // adds it back, so the overlay offsets are unchanged.
  lefts.set("a", 30).set("b", 110);
  wrap.scrollLeft = 30;
  act(() => {
    wrap.dispatchEvent(new Event("scroll"));
  });
  expect(measured().positions[0]).toEqual({ left: 10, width: 80 });
});

test("a window resize re-measures shifted columns", () => {
  render(<Probe enabled />);
  lefts.set("b", 200);
  tableWidth = 520;
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  expect(measured()).toEqual({
    positions: [
      { left: 10, width: 80 },
      { left: 150, width: 80 },
    ],
    tableWidth: 520,
  });
});

test("a changed column set re-measures", () => {
  const { rerender } = render(<Probe enabled />);
  lefts.set("c", 220);
  rerender(<Probe enabled cols={["a", "b", "c"]} />);
  expect(measured().positions).toHaveLength(3);
  expect(measured().positions[2]).toEqual({ left: 170, width: 80 });
});

test("turning it off clears the measurements", () => {
  const { rerender } = render(<Probe enabled />);
  expect(measured().positions).toHaveLength(2);
  rerender(<Probe enabled={false} />);
  expect(measured()).toEqual({ positions: [], tableWidth: 0 });
});

test("without the data table the overlay width is zero", () => {
  render(<Probe enabled table={false} />);
  expect(measured().tableWidth).toBe(0);
  expect(measured().positions).toHaveLength(2);
});

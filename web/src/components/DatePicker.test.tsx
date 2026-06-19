import { fireEvent, render, screen, within } from "@testing-library/react";
import { DatePicker } from "./DatePicker";

function open(props: Partial<Parameters<typeof DatePicker>[0]> = {}) {
  localStorage.clear();
  render(
    <DatePicker
      dates={["2026-04-10"]}
      counts={{ "2026-04-10": 171 }}
      maxSeq={{ "2026-04-10": 174 }}
      value="2026-04-10"
      onChange={() => {}}
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /2026-04-10/ }));
  return screen.getByRole("dialog");
}

test("per-seq camera: month cell shows max seq, no has-data dot", () => {
  const dialog = open();
  const cell = within(dialog).getByTitle("2026-04-10 · max seq 174");
  // The seq number is rendered; the redundant dot class is absent.
  expect(cell.textContent).toContain("174");
  expect(cell.className).not.toContain("has-data");
});

test("per-seq camera: heatmap tints by exposure count", () => {
  const dialog = open();
  fireEvent.click(within(dialog).getByRole("tab", { name: "Heatmap" }));
  // Count-mode legend (less … more) and a count title.
  expect(within(dialog).getByText("more")).toBeDefined();
  expect(within(dialog).getByTitle("2026-04-10 · 171 exposures")).toBeDefined();
});

test("All Sky: month cell is a dot, heatmap is binary (has movie)", () => {
  const dialog = open({ allSky: true });
  // Month view: dot, no seq.
  expect(within(dialog).getByTitle("2026-04-10 · has data")).toBeDefined();
  expect(within(dialog).queryByTitle(/max seq/)).toBeNull();

  fireEvent.click(within(dialog).getByRole("tab", { name: "Heatmap" }));
  // Binary: "movie" title + "has movie" legend, not an exposure count.
  expect(within(dialog).getByTitle("2026-04-10 · movie")).toBeDefined();
  expect(within(dialog).getByText("has movie")).toBeDefined();
  expect(within(dialog).queryByText("more")).toBeNull();
});

test("heatmap lays months out 6-across (12 mini-months per year)", () => {
  const { container } = render(
    <DatePicker
      dates={["2026-04-10"]}
      counts={{ "2026-04-10": 5 }}
      maxSeq={{}}
      value="2026-04-10"
      onChange={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /2026-04-10/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Heatmap" }));
  // One year (2026) → 12 mini-month blocks.
  expect(container.querySelectorAll(".dh-mini").length).toBe(12);
});

test("heatmap day click selects the date directly", () => {
  const onChange = vi.fn();
  render(
    <DatePicker
      dates={["2026-04-10"]}
      counts={{ "2026-04-10": 5 }}
      maxSeq={{}}
      value="2026-04-10"
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /2026-04-10/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Heatmap" }));
  fireEvent.click(screen.getByTitle("2026-04-10 · 5 exposures"));
  expect(onChange).toHaveBeenCalledWith("2026-04-10");
});

test("heatmap month-title click opens that month in the Months view", () => {
  render(
    <DatePicker
      dates={["2026-04-10"]}
      counts={{ "2026-04-10": 5 }}
      maxSeq={{}}
      value="2026-04-10"
      onChange={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /2026-04-10/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Heatmap" }));
  // Click the August month label; the picker switches to Months showing August.
  fireEvent.click(screen.getByTitle("Open Aug 2026 in the month view"));
  expect(
    (screen.getByRole("tab", { name: "Months" }) as HTMLElement).getAttribute(
      "aria-selected",
    ),
  ).toBe("true");
  expect(screen.getByText("August")).toBeDefined();
});

test("alternating year stripe distinguishes adjacent years", () => {
  const { container } = render(
    <DatePicker
      dates={["2026-04-10", "2025-08-30"]}
      counts={{ "2026-04-10": 5, "2025-08-30": 5 }}
      maxSeq={{}}
      value="2026-04-10"
      onChange={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /2026-04-10/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Heatmap" }));
  const yearBlocks = container.querySelectorAll(".dh-year");
  expect(yearBlocks.length).toBe(2);
  // First year plain, second striped.
  expect(yearBlocks[0].className).not.toContain("alt");
  expect(yearBlocks[1].className).toContain("alt");
});

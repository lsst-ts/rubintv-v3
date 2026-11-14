import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

test("month-view selectable day is a keyboard-operable button", () => {
  const onChange = vi.fn();
  const dialog = open({ onChange });
  // The day with data renders as a <button> (was a mouse-only <div onClick>),
  // so it's reachable by keyboard and activatable with Enter/Space.
  const cell = within(dialog).getByTitle("2026-04-10 · max seq 174");
  expect(cell.tagName).toBe("BUTTON");
  fireEvent.click(cell);
  expect(onChange).toHaveBeenCalledWith("2026-04-10");
});

test("per-seq camera: heatmap tints by exposure count", () => {
  const dialog = open();
  fireEvent.click(within(dialog).getByRole("tab", { name: "Heatmap" }));
  // Count-mode legend (less … more) and a count title.
  expect(within(dialog).getByText("more")).toBeDefined();
  expect(within(dialog).getByTitle("2026-04-10 · 171 exposures")).toBeDefined();
});

test("movie nights: month cell is a dot, heatmap is binary (has movie)", () => {
  const dialog = open({ movies: true });
  // Month view: dot, no seq.
  expect(within(dialog).getByTitle("2026-04-10 · movie")).toBeDefined();
  expect(within(dialog).queryByTitle(/max seq/)).toBeNull();

  fireEvent.click(within(dialog).getByRole("tab", { name: "Heatmap" }));
  // Binary: "movie" title + "has movie" legend, not an exposure count.
  expect(within(dialog).getByTitle("2026-04-10 · movie")).toBeDefined();
  expect(within(dialog).getByText("has movie")).toBeDefined();
  expect(within(dialog).queryByText("more")).toBeNull();
});

test("the title names whose dates the picker offers, and what they are", () => {
  const exposures = open({ title: "AuxTel" });
  expect(exposures.getAttribute("aria-label")).toBe("Choose date: AuxTel");
  expect(within(exposures).getByText("nights with exposures")).toBeDefined();
  expect(exposures.closest(".date-cluster")?.className).not.toContain(
    "is-movies",
  );
  // No per-night data: no marks and no key.
  expect(exposures.querySelector(".has-per-day, .dp-title-key")).toBeNull();
});

test("days with a per-night artifact are marked in both views and keyed", () => {
  const dialog = open({
    title: "AuxTel",
    perDay: { "2026-04-10": ["Tonight's Movie"] },
  });
  // Months: the day is marked and its tooltip names the channel.
  const cell = within(dialog).getByTitle(
    "2026-04-10 · max seq 174 · Tonight's Movie",
  );
  expect(cell.className).toContain("has-per-day");
  // The heading keys the mark with the channel's title.
  expect(
    within(dialog).getByText("Tonight's Movie").closest(".dp-title-key"),
  ).not.toBeNull();

  fireEvent.click(within(dialog).getByRole("tab", { name: "Heatmap" }));
  const heat = within(dialog).getByTitle(
    "2026-04-10 · 171 exposures · Tonight's Movie",
  );
  expect(heat.className).toContain("has-per-day");
});

test("marks spanning several per-night channels get a general key", () => {
  const dialog = open({
    title: "ComCam",
    perDay: { "2026-04-10": ["Whole Day Movie", "Last N Images Movie"] },
  });
  expect(
    within(dialog).getByTitle(
      "2026-04-10 · max seq 174 · Whole Day Movie, Last N Images Movie",
    ),
  ).toBeDefined();
  expect(within(dialog).getByText("per-night data")).toBeDefined();
});

test("a movie-nights picker is marked apart from an exposure picker", () => {
  const dialog = open({ movies: true, title: "Tonight's Movie" });
  expect(within(dialog).getByText("Tonight's Movie")).toBeDefined();
  expect(within(dialog).getByText("nights with a movie")).toBeDefined();
  // The cluster carries the movie colour hook; the trigger says what kind of
  // night it is.
  expect(dialog.closest(".date-cluster")?.className).toContain("is-movies");
  expect(
    screen.getByRole("button", { name: /2026-04-10/ }).getAttribute("title"),
  ).toMatch(/^Movie for /);
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

test("trigger chip is tinted live when the date is the current day_obs", () => {
  render(
    <DatePicker
      dates={["2026-04-10"]}
      counts={{ "2026-04-10": 5 }}
      maxSeq={{}}
      value="2026-04-10"
      isCurrentDayObs
      onChange={() => {}}
    />,
  );
  const trigger = screen.getByRole("button", { name: /2026-04-10/ });
  expect(trigger.className).toContain("is-live-day");
  expect(trigger.className).not.toContain("is-past-day");
  expect(trigger.getAttribute("title")).toMatch(/Current observing day/);
});

test("trigger chip is tinted historical when the date isn't the current day_obs", () => {
  render(
    <DatePicker
      dates={["2026-04-10"]}
      counts={{ "2026-04-10": 5 }}
      maxSeq={{}}
      value="2026-04-10"
      isCurrentDayObs={false}
      onChange={() => {}}
    />,
  );
  const trigger = screen.getByRole("button", { name: /2026-04-10/ });
  expect(trigger.className).toContain("is-past-day");
  expect(trigger.className).not.toContain("is-live-day");
  expect(trigger.getAttribute("title")).toMatch(/Historical day/);
});

const monthHeads = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll(".dp-mhead")].map((h) =>
    h.querySelector(".month")!.textContent + " " + h.querySelector(".yr")!.textContent,
  );

test("the month arrows step by month and year, across year ends", () => {
  localStorage.clear();
  render(
    <DatePicker
      dates={["2026-01-10"]}
      counts={{}}
      maxSeq={{}}
      value="2026-01-10"
      onChange={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /2026-01-10/ }));
  const dialog = screen.getByRole("dialog");
  // Two months side by side, from the selected date's month.
  expect(monthHeads(dialog)).toEqual(["January 2026", "February 2026"]);
  fireEvent.click(within(dialog).getByTitle("Previous month"));
  expect(monthHeads(dialog)).toEqual(["December 2025", "January 2026"]);
  fireEvent.click(within(dialog).getByTitle("Next year"));
  expect(monthHeads(dialog)).toEqual(["December 2026", "January 2027"]);
  fireEvent.click(within(dialog).getByTitle("Next month"));
  expect(monthHeads(dialog)).toEqual(["January 2027", "February 2027"]);
  fireEvent.click(within(dialog).getByTitle("Previous year"));
  expect(monthHeads(dialog)).toEqual(["January 2026", "February 2026"]);
});

test("a month grid holds only its own days, the 1st under its weekday", () => {
  const dialog = open();
  const [april, may] = [...dialog.querySelectorAll(".dp-grid")];
  const days = april.querySelectorAll<HTMLElement>(".dp-day");
  // No greyed-out March or May days padding April out to six weeks.
  expect(days).toHaveLength(30);
  expect(days[0].textContent).toBe("1");
  // 1 April 2026 is a Wednesday, the grid's third column.
  expect(days[0].style.gridColumnStart).toBe("3");
  expect(days[1].style.gridColumnStart).toBe("");
  expect(may.querySelectorAll(".dp-day")).toHaveLength(31);
});

describe("the months the picker opens on", () => {
  afterEach(() => vi.useRealTimers());

  function openAt(now: string, value: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    localStorage.clear();
    render(
      <DatePicker
        dates={[value]}
        counts={{}}
        maxSeq={{}}
        value={value}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: value }));
    return screen.getByRole("dialog");
  }

  test("the current month opens on the right, not beside a future one", () => {
    const dialog = openAt("2026-11-12T16:00:00Z", "2026-11-12");
    expect(monthHeads(dialog)).toEqual(["October 2026", "November 2026"]);
  });

  test("last month opens on the left, beside the current one", () => {
    const dialog = openAt("2026-11-12T16:00:00Z", "2026-10-20");
    expect(monthHeads(dialog)).toEqual(["October 2026", "November 2026"]);
  });

  test("an older month opens on the left, beside the month after it", () => {
    const dialog = openAt("2026-11-12T16:00:00Z", "2026-07-10");
    expect(monthHeads(dialog)).toEqual(["July 2026", "August 2026"]);
  });

  test("across a year end", () => {
    const dialog = openAt("2027-01-05T16:00:00Z", "2027-01-05");
    expect(monthHeads(dialog)).toEqual(["December 2026", "January 2027"]);
  });

  test("the current month is the observing day's, not the UTC date's", () => {
    // 06:00 UTC on 1 December is still day_obs 2026-11-30: December hasn't
    // started, so November stays on the right.
    const dialog = openAt("2026-12-01T06:00:00Z", "2026-11-30");
    expect(monthHeads(dialog)).toEqual(["October 2026", "November 2026"]);
  });

  test("a heatmap jump to the current month puts it on the right", () => {
    const dialog = openAt("2026-11-12T16:00:00Z", "2026-11-12");
    fireEvent.click(within(dialog).getByRole("tab", { name: "Heatmap" }));
    fireEvent.click(within(dialog).getByTitle("Open Nov 2026 in the month view"));
    expect(monthHeads(dialog)).toEqual(["October 2026", "November 2026"]);
  });
});

test("a day with data but no max seq says it has data", () => {
  const dialog = open({ maxSeq: {} });
  expect(within(dialog).getByTitle("2026-04-10 · has data")).toBeDefined();
});

test("jump to latest picks the newest date, by click or keyboard", () => {
  const onChange = vi.fn();
  const props = {
    dates: ["2026-04-10", "2026-03-01"],
    counts: {},
    maxSeq: {},
    value: "2026-03-01",
    onChange,
  };
  localStorage.clear();
  render(<DatePicker {...props} />);
  const trigger = screen.getByRole("button", { name: /2026-03-01/ });
  const latest = () => screen.getByRole("button", { name: "jump to latest" });

  fireEvent.click(trigger);
  fireEvent.click(latest());
  expect(onChange).toHaveBeenLastCalledWith("2026-04-10");
  expect(screen.queryByRole("dialog")).toBeNull(); // picking closes it

  fireEvent.click(trigger);
  expect(fireEvent.keyDown(latest(), { key: "Tab" })).toBe(true);
  expect(onChange).toHaveBeenCalledTimes(1);
  // Space must not also scroll the page.
  expect(fireEvent.keyDown(latest(), { key: " " })).toBe(false);
  expect(onChange).toHaveBeenCalledTimes(2);
  fireEvent.click(trigger);
  fireEvent.keyDown(latest(), { key: "Enter" });
  expect(onChange).toHaveBeenCalledTimes(3);
});

test("a heatmap month opens in the Months view from the keyboard too", () => {
  const dialog = open({ counts: { "2026-04-10": 5 } });
  fireEvent.click(within(dialog).getByRole("tab", { name: "Heatmap" }));
  const aug = within(dialog).getByTitle("Open Aug 2026 in the month view");

  // A key on a day inside the month belongs to that day, not the month.
  const apr = within(dialog).getByTitle("Open Apr 2026 in the month view");
  fireEvent.keyDown(within(apr).getByTitle("2026-04-10 · 5 exposures"), {
    key: "Enter",
  });
  expect(within(dialog).getByRole("tab", { name: "Heatmap" })
    .getAttribute("aria-selected")).toBe("true");

  fireEvent.keyDown(aug, { key: "Tab" });
  expect(within(dialog).getByRole("tab", { name: "Heatmap" })
    .getAttribute("aria-selected")).toBe("true");
  expect(fireEvent.keyDown(aug, { key: " " })).toBe(false);
  expect(monthHeads(dialog)[0]).toBe("August 2026");
});

test("heatmap shades days by how many exposures they had", () => {
  const counts = {
    "2026-04-01": 0,
    "2026-04-02": 1,
    "2026-04-03": 100,
    "2026-04-04": 500,
    "2026-04-05": 5000,
  };
  const dialog = open({ dates: Object.keys(counts).reverse(), counts });
  fireEvent.click(within(dialog).getByRole("tab", { name: "Heatmap" }));
  const lv = (title: string) =>
    within(dialog).getByTitle(title).className.match(/lv-\S+/)?.[0];
  expect(lv("2026-04-01 · 0 exposures")).toBe("lv-0");
  expect(lv("2026-04-02 · 1 exposure")).toBe("lv-1");
  expect(lv("2026-04-03 · 100 exposures")).toBe("lv-2");
  expect(lv("2026-04-04 · 500 exposures")).toBe("lv-3");
  expect(lv("2026-04-05 · 5000 exposures")).toBe("lv-4");
});

test("a heatmap with no dates says so", () => {
  localStorage.clear();
  render(
    <DatePicker dates={[]} counts={{}} maxSeq={{}} value="" onChange={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /select date/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Heatmap" }));
  expect(screen.getByText("No dates with data.")).toBeDefined();
});

test("a movie picker's chip explains its live or past tint", () => {
  const { unmount } = render(
    <DatePicker
      movies
      isCurrentDayObs
      dates={["2026-04-10"]}
      counts={{}}
      maxSeq={{}}
      value="2026-04-10"
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("button").getAttribute("title")).toBe(
    "Movie for the current observing night.",
  );
  unmount();
  render(
    <DatePicker
      movies
      dates={["2026-04-10"]}
      counts={{}}
      maxSeq={{}}
      value="2026-04-10"
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("button").getAttribute("title")).toMatch(
    /past night/,
  );
});

test("the view choice still works where storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  try {
    render(
      <DatePicker
        dates={["2026-04-10"]}
        counts={{}}
        maxSeq={{}}
        value="2026-04-10"
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /2026-04-10/ }));
    const heatmap = screen.getByRole("tab", { name: "Heatmap" });
    expect(screen.getByRole("tab", { name: "Months" }).getAttribute("aria-selected"))
      .toBe("true");
    fireEvent.click(heatmap);
    expect(heatmap.getAttribute("aria-selected")).toBe("true");
  } finally {
    vi.restoreAllMocks();
  }
});

describe("across the noon-UTC day rollover", () => {
  afterEach(() => vi.useRealTimers());

  test("the new observing day becomes pickable without a reload", () => {
    // 11:59 UTC on the 10th is still day_obs 2026-04-09: the 10th is future.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T11:59:30Z"));
    const dialog = open({ maxSeq: {} });
    const cell = () => within(dialog).getByTitle("2026-04-10 · has data");
    expect(cell().tagName).toBe("DIV");
    expect(cell().className).toContain("disabled");

    // The picker re-reads day_obs each minute; past noon the 10th is today.
    act(() => vi.advanceTimersByTime(60_000));
    expect(cell().tagName).toBe("BUTTON");
    expect(cell().className).toContain("today");
  });
});

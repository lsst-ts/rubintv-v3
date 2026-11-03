import { fireEvent } from "@testing-library/react";
import * as d3 from "d3";
import * as Astronomy from "astronomy-engine";
import { renderGuide } from "./timeline";
import type { GuideBlockDatum, GuideBlockInput, RenderGuideOptions } from "./timeline";

// The timeline mounted directly into the `.guide-*` markup the Guide view
// renders. futureMonths: 0 keeps the chart to the nights the blocks cover, so
// the per-row twilight and moon searches stay quick.

// Pass-through spies, so a test can make the sun/moon searches fail.
vi.mock("astronomy-engine", async (importOriginal) => {
  const mod = await importOriginal<typeof import("astronomy-engine")>();
  return {
    ...mod,
    SearchAltitude: vi.fn(mod.SearchAltitude),
    SearchRiseSet: vi.fn(mod.SearchRiseSet),
  };
});

const MARKUP = `
  <div class="guide-chart"></div>
  <div class="guide-search-container">
    <input class="guide-search-input" />
    <div class="guide-search-results" style="display: none"></div>
  </div>
  <div class="guide-info-panel empty">
    <h3 class="guide-panel-title">Selection Info</h3>
    <div class="guide-panel-content"></div>
  </div>
  <div class="guide-floating-axis"><svg class="guide-floating-axis-svg"></svg></div>`;

function block(program: string, begin: string, end: string, seq0: number, seq1: number): GuideBlockInput {
  return { program, begin, end, seq_num_0: seq0, seq_num_1: seq1 };
}

// Three observing nights (12:00 UTC rollover). Rows are drawn earliest first,
// so "up" is the night before.
const NIGHTS: GuideBlockInput[] = [
  // 2025-04-11
  block("BLOCK-T2", "2025-04-12T01:00:00Z", "2025-04-12T01:30:00Z", 1, 20),
  // 2025-04-12
  block("BLOCK-T1", "2025-04-13T01:00:00Z", "2025-04-13T01:40:00Z", 10, 50),
  block("BLOCK-T1_v2", "2025-04-13T03:00:00Z", "2025-04-13T03:30:00Z", 60, 80),
  block("BLOCK-T2", "2025-04-13T05:00:00Z", "2025-04-13T05:20:00Z", 90, 100),
  // 2025-04-13
  block("BLOCK-T3", "2025-04-14T01:10:00Z", "2025-04-14T01:30:00Z", 5, 20),
  block("BLOCK-T3", "2025-04-14T05:00:00Z", "2025-04-14T05:30:00Z", 30, 40),
];

const NAMES = { "BLOCK-T1": "Science survey", "BLOCK-T123": "Numbered block" };

let root: HTMLElement;
let handle: { dispose: () => void } | null = null;

function mount(blocks: GuideBlockInput[] = NIGHTS, opts: Partial<RenderGuideOptions> = {}, parent: HTMLElement = document.body) {
  root = document.createElement("section");
  root.innerHTML = MARKUP;
  parent.appendChild(root);
  handle = renderGuide(root, { blocks, names: NAMES, dayStartUtcHour: 12, futureMonths: 0, ...opts });
  return root;
}

beforeEach(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => {
  handle?.dispose();
  handle = null;
  root.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const datum = (el: Element) => d3.select<Element, GuideBlockDatum>(el).datum();
const rects = () => Array.from(root.querySelectorAll<SVGRectElement>("rect.block"));
const rect = (program: string, seq0: number) =>
  rects().find((r) => datum(r).program === program && datum(r).seq_num_0 === seq0)!;
const text = (sel: string) => (root.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
const panelTitle = () => text(".guide-panel-title");
const panel = () => text(".guide-panel-content");
// The [program, seq_num_0] of the one selected block (selection marks every
// part of a spanning block, so these are deduplicated).
const selected = () => {
  const keys = rects()
    .filter((r) => r.classList.contains("selected"))
    .map((r) => `${datum(r).program}#${datum(r).seq_num_0}`);
  return Array.from(new Set(keys));
};
const input = () => root.querySelector<HTMLInputElement>(".guide-search-input")!;
const results = () => root.querySelector<HTMLDivElement>(".guide-search-results")!;
const resultItems = () => Array.from(results().querySelectorAll<HTMLElement>(".search-result-item"));
const search = (value: string) => fireEvent.input(input(), { target: { value } });
const key = (k: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key: k, ...init });

describe("drawing", () => {
  test("a block over three nights draws a full-width middle part and a spanning tooltip", () => {
    mount([block("BLOCK-T9", "2025-04-13T11:00:00Z", "2025-04-14T13:00:00Z", 300, 40)]);
    const parts = rects().sort((a, b) => datum(a).day.localeCompare(datum(b).day));
    expect(parts.map((r) => datum(r).day)).toEqual(["2025-04-12", "2025-04-13", "2025-04-14"]);
    // 800px minimum width less the 80 + 20 margins: 700px for 24 hours.
    const widths = parts.map((r) => Number(r.getAttribute("width")));
    expect(widths[0]).toBeCloseTo(700 / 24);
    expect(widths[1]).toBeCloseTo(700);
    expect(widths[2]).toBeCloseTo(700 / 24);

    const tooltip = document.querySelector<HTMLElement>(".guide-tooltip")!;
    fireEvent.mouseEnter(parts[1]);
    expect(tooltip.style.opacity).toBe("1");
    const tip = tooltip.textContent ?? "";
    expect(tip).toContain("Day: 2025-04-13");
    expect(tip).toContain("Begin: 11:00");
    expect(tip).toContain("End: 13:00");
    expect(tip).toContain("Duration: 26.00 h (spans days)");
    fireEvent.mouseMove(parts[1], { clientX: 100, clientY: 50 });
    expect(tooltip.style.left).toBe("110px");
    expect(tooltip.style.top).toBe("60px");
    fireEvent.mouseLeave(parts[1]);
    expect(tooltip.style.opacity).toBe("0");
  });

  test("BLOCK-NNN programs take the description of BLOCK-TNNN when there is one", () => {
    mount([
      block("BLOCK-123", "2025-04-13T01:00:00Z", "2025-04-13T01:30:00Z", 1, 10),
      block("BLOCK-124", "2025-04-13T02:00:00Z", "2025-04-13T02:30:00Z", 11, 20),
    ]);
    fireEvent.click(rect("BLOCK-123", 1));
    expect(panel()).toContain("Description: Numbered block");
    fireEvent.click(rect("BLOCK-124", 11));
    expect(panel()).toContain("Program: BLOCK-124");
    expect(panel()).not.toContain("Description:");
  });

  test("a night whose sun and moon searches fail is drawn as daylight with no moon", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = () => {
      throw new Error("no convergence");
    };
    vi.mocked(Astronomy.SearchAltitude).mockImplementation(boom);
    vi.mocked(Astronomy.SearchRiseSet).mockImplementation(boom);
    try {
      mount([NIGHTS[1]]);
      const bands = root.querySelectorAll(".twilight-background");
      expect(bands).toHaveLength(1);
      expect(bands[0].getAttribute("fill")).toBe("#ffffe0");
      expect(Number(bands[0].getAttribute("width"))).toBeCloseTo(700);
      expect(root.querySelectorAll(".moon-overlay")).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith("Could not find sunset for 2025-04-12:", "no convergence");
      expect(warn).toHaveBeenCalledWith("Could not find moon rise/set for 2025-04-12:", "no convergence");
    } finally {
      vi.mocked(Astronomy.SearchAltitude).mockReset();
      vi.mocked(Astronomy.SearchRiseSet).mockReset();
    }
  });

  test("dispose removes the chart, the tooltip and the document listeners", () => {
    mount();
    expect(document.querySelector(".guide-tooltip")).not.toBeNull();
    handle!.dispose();
    handle = null;
    expect(root.querySelector(".guide-chart")!.children).toHaveLength(0);
    expect(root.querySelector(".guide-floating-axis-svg")!.children).toHaveLength(0);
    expect(document.querySelector(".guide-tooltip")).toBeNull();
    key("/");
    expect(document.activeElement).not.toBe(input());
  });
});

describe("time-zone axes", () => {
  const axisOpacity = (cls: string) => root.querySelector<SVGGElement>(`.${cls}`)!.style.opacity;

  // Chile's 2025 switches (America/Santiago): summer time ended at the start
  // of 6 April and began at the start of 7 September.
  test.each([
    ["2025-04-05T15:00:00Z", true], // last day of summer time
    ["2025-04-10T15:00:00Z", false],
    ["2025-07-01T15:00:00Z", false],
    ["2025-09-03T15:00:00Z", false], // early September is still winter time
    ["2025-09-10T15:00:00Z", true],
    ["2025-12-01T15:00:00Z", true],
  ])("at %s Chile summer time is %s", (now, summer) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    mount();
    expect(axisOpacity("x-axis-clst")).toBe(summer ? "1" : "0.3");
    expect(axisOpacity("x-axis-clt")).toBe(summer ? "0.3" : "1");
  });

  test("the local axis is labelled with the zone's abbreviation, or its UTC offset", () => {
    // Only the label's formatter asks for a "short" zone name; the Chile
    // check asks for "shortOffset" and is left alone.
    const real = Intl.DateTimeFormat.prototype.formatToParts;
    let zone = "CEST";
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(function (
      this: Intl.DateTimeFormat,
      date?: Date | number,
    ) {
      const parts = real.call(this, date);
      if (this.resolvedOptions().timeZoneName !== "short") return parts;
      return parts.map((p) => (p.type === "timeZoneName" ? { ...p, value: zone } : p));
    });
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-120);
    const label = () =>
      Array.from(root.querySelectorAll(".axis-label")).map((t) => t.textContent).pop();

    mount();
    expect(label()).toBe("Local (CEST)");
    handle!.dispose();
    root.remove();

    zone = "GMT";
    mount();
    expect(label()).toBe("Local (UTC+2)");
  });
});

describe("program summary", () => {
  test("double-click summarises every version of the program", () => {
    mount();
    fireEvent.dblClick(rect("BLOCK-T1", 10));
    expect(panelTitle()).toBe("Program Summary");
    const summary = panel();
    expect(summary).toContain("Program: BLOCK-T1 (2 versions)");
    expect(summary).toContain("Versions: BLOCK-T1, BLOCK-T1_v2");
    expect(summary).toContain("Description: Science survey");
    expect(summary).toContain("Total Blocks: 2");
    expect(summary).toContain("Total Duration: 1.17 hours");
    expect(summary).toContain("Average Duration: 0.58 hours");
    expect(summary).toContain("Date Range: 2025-04-12 to 2025-04-12");
    expect(rects().filter((r) => r.classList.contains("highlighted"))).toHaveLength(2);
  });

  test("lists blocks by night then seq, and a row flashes just its block", () => {
    mount([
      block("BLOCK-T5", "2025-04-14T01:00:00Z", "2025-04-14T01:30:00Z", 7, 9),
      block("BLOCK-T5", "2025-04-13T11:00:00Z", "2025-04-13T13:00:00Z", 300, 4),
      block("BLOCK-T5", "2025-04-13T01:00:00Z", "2025-04-13T01:30:00Z", 100, 120),
    ]);
    fireEvent.dblClick(rect("BLOCK-T5", 7));
    const items = Array.from(root.querySelectorAll<HTMLElement>(".guide-block-item"));
    expect(items.map((i) => i.textContent!.replace(/\s+/g, " ").trim())).toEqual([
      "BLOCK-T5 2025-04-12 | Seq: 100-120 | 0.50h",
      "BLOCK-T5 2025-04-12 | Seq: 300-4 | 2.00h",
      "BLOCK-T5 2025-04-13 | Seq: 7-9 | 0.50h",
    ]);
    fireEvent.click(items[2]);
    const flashing = rects().filter((r) => r.classList.contains("flash"));
    expect(flashing.map((r) => datum(r).seq_num_0)).toEqual([7]);
    // The summary stays up.
    expect(panelTitle()).toBe("Program Summary");
  });

  test("the date range takes in blocks that cross the day rollover", () => {
    mount([
      // E8157's only block runs from the night of 06-19 into 06-20.
      block("E8157", "2025-06-20T10:00:00Z", "2025-06-20T14:00:00Z", 500, 12),
      // BLOCK-T454 starts within a night and ends with a block into 07-03.
      block("BLOCK-T454", "2025-04-17T03:00:00Z", "2025-04-17T04:00:00Z", 10, 40),
      block("BLOCK-T454", "2025-07-03T10:19:00Z", "2025-07-03T20:49:00Z", 616, 53),
    ]);
    fireEvent.dblClick(rect("E8157", 500));
    expect(panel()).toContain("Date Range: 2025-06-19 to 2025-06-20");
    fireEvent.dblClick(rect("BLOCK-T454", 10));
    expect(panel()).toContain("Total Blocks: 2");
    expect(panel()).toContain("Date Range: 2025-04-16 to 2025-07-03");
  });
});

describe("search", () => {
  test("matches a description and lists the program's versions", () => {
    mount();
    search("survey");
    expect(results().style.display).toBe("block");
    expect(resultItems()).toHaveLength(1);
    expect(text(".search-program")).toBe("BLOCK-T1");
    expect(text(".search-description")).toBe("Science survey");
    expect(text(".search-versions")).toBe("2 versions: BLOCK-T1, BLOCK-T1_v2");
  });

  test("a match on one version shows only that version", () => {
    mount();
    search("_v2");
    expect(resultItems()).toHaveLength(1);
    expect(text(".search-program")).toBe("BLOCK-T1");
    expect(text(".search-versions")).toBe("Version: BLOCK-T1_v2");
  });

  test("matches letters in order when the query isn't a substring", () => {
    mount();
    search("bt3");
    expect(resultItems()).toHaveLength(1);
    expect(text(".search-program")).toBe("BLOCK-T3");
    expect(root.querySelector(".search-description")).toBeNull();
  });

  test("an empty or unmatched query hides the results", () => {
    mount();
    search("block");
    expect(results().style.display).toBe("block");
    search("");
    expect(results().style.display).toBe("none");
    search("zzz");
    expect(results().style.display).toBe("none");
    // Nothing to move through.
    key("ArrowDown", {}, input());
    expect(results().querySelector(".search-highlighted")).toBeNull();
  });

  test("arrow keys move through the results and Enter selects one", () => {
    mount();
    search("block");
    // Results keep the programs' first-seen order (all score equally).
    expect(resultItems().map((i) => i.querySelector(".search-program")!.textContent)).toEqual([
      "BLOCK-T2",
      "BLOCK-T1",
      "BLOCK-T3",
    ]);
    const highlighted = () => resultItems().findIndex((i) => i.classList.contains("search-highlighted"));
    // jsdom has no scrollIntoView; the highlighted result is scrolled into
    // view where there is one.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      key("ArrowDown", {}, input());
      key("ArrowDown", {}, input());
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    expect(highlighted()).toBe(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.contexts[1]).toBe(resultItems()[1]);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
    key("ArrowUp", {}, input());
    expect(highlighted()).toBe(0);
    // Clamped at both ends; above the first result nothing is highlighted.
    for (let i = 0; i < 5; i++) key("ArrowDown", {}, input());
    expect(highlighted()).toBe(2);
    for (let i = 0; i < 5; i++) key("ArrowUp", {}, input());
    expect(highlighted()).toBe(-1);
    key("Enter", {}, input());
    expect(results().style.display).toBe("block");

    key("ArrowDown", {}, input());
    key("Enter", {}, input());
    // BLOCK-T2 has two blocks, so it gets the program summary.
    expect(panelTitle()).toBe("Program Summary");
    expect(panel()).toContain("Program: BLOCK-T2");
    expect(rects().filter((r) => r.classList.contains("highlighted"))).toHaveLength(2);
    expect(input().value).toBe("");
    expect(results().style.display).toBe("none");
    expect(window.scrollTo).toHaveBeenCalled();
  });

  test("picking a program whose one block crosses the rollover shows that block", () => {
    mount([
      block("E8157", "2025-06-20T10:00:00Z", "2025-06-20T14:00:00Z", 500, 12),
      block("BLOCK-T1", "2025-06-21T03:00:00Z", "2025-06-21T04:00:00Z", 30, 60),
    ]);
    search("E8157");
    fireEvent.click(resultItems()[0]);
    // Drawn as two parts, but one block: its details, not a summary.
    expect(panelTitle()).toBe("Block Information");
    expect(panel()).toContain("Observation Day: 2025-06-19");
    expect(rects().filter((r) => r.classList.contains("selected"))).toHaveLength(2);
    // And the arrow keys move on from it.
    key("ArrowDown");
    expect(selected()).toEqual(["BLOCK-T1#30"]);
  });

  test("Escape clears the search, and a click outside it closes the results", () => {
    mount();
    input().focus();
    search("block");
    key("Escape", {}, input());
    expect(input().value).toBe("");
    expect(results().style.display).toBe("none");
    expect(document.activeElement).not.toBe(input());

    search("block");
    fireEvent.click(input());
    expect(results().style.display).toBe("block");
    fireEvent.click(document.body);
    expect(results().style.display).toBe("none");
  });
});

describe("keyboard", () => {
  test("/ and Ctrl+F focus the search box", () => {
    mount();
    key("/");
    expect(document.activeElement).toBe(input());
    input().blur();
    key("f", { ctrlKey: true });
    expect(document.activeElement).toBe(input());
  });

  test("arrow keys move the selection along a night and between nights", () => {
    mount();
    fireEvent.click(rect("BLOCK-T1", 10));
    key("ArrowRight");
    expect(selected()).toEqual(["BLOCK-T1_v2#60"]);
    expect(panel()).toContain("Sequence Range: 60 - 80");
    key("ArrowRight");
    expect(selected()).toEqual(["BLOCK-T2#90"]);
    key("ArrowRight"); // last on the night: stays
    expect(selected()).toEqual(["BLOCK-T2#90"]);
    key("ArrowLeft");
    expect(selected()).toEqual(["BLOCK-T1_v2#60"]);
    // Down to the next night, onto the block nearest in time (01:10 is
    // closer to 03:00 than 05:00 is).
    key("ArrowDown");
    expect(selected()).toEqual(["BLOCK-T3#5"]);
    // Up from 01:10 lands on 01:00 the night before, then up again.
    key("ArrowUp");
    expect(selected()).toEqual(["BLOCK-T1#10"]);
    key("ArrowUp");
    expect(selected()).toEqual(["BLOCK-T2#1"]);
    expect(rect("BLOCK-T2", 1).classList.contains("flash")).toBe(true);
    key("ArrowLeft"); // first on the night: stays
    expect(selected()).toEqual(["BLOCK-T2#1"]);
  });

  test("Up and Down go to the nearest night with blocks, and stop at the first and last", () => {
    // Out of order, with an empty night (2025-04-12) between the first two.
    mount([
      block("BLOCK-T3", "2025-04-15T01:00:00Z", "2025-04-15T01:30:00Z", 3, 9), // 2025-04-14
      block("BLOCK-T2", "2025-04-14T01:00:00Z", "2025-04-14T01:30:00Z", 2, 9), // 2025-04-13
      block("BLOCK-T1", "2025-04-12T01:00:00Z", "2025-04-12T01:30:00Z", 1, 9), // 2025-04-11
    ]);
    fireEvent.click(rect("BLOCK-T1", 1));
    key("ArrowUp"); // the first night: stays
    expect(selected()).toEqual(["BLOCK-T1#1"]);
    key("ArrowDown"); // past the empty night to 2025-04-13, not on to 2025-04-14
    expect(selected()).toEqual(["BLOCK-T2#2"]);
    key("ArrowDown");
    expect(selected()).toEqual(["BLOCK-T3#3"]);
    key("ArrowDown"); // the last night: stays
    expect(selected()).toEqual(["BLOCK-T3#3"]);
    key("ArrowUp");
    expect(selected()).toEqual(["BLOCK-T2#2"]);
    key("ArrowUp");
    expect(selected()).toEqual(["BLOCK-T1#1"]);
  });

  test("Up and Down pass a block that crosses into a night with nothing else on it", () => {
    // As BLOCK-T454 did on 2025-06-09: a daytime block across the 12:00 UTC
    // rollover, the next night otherwise empty.
    mount([
      block("BLOCK-T501", "2025-06-10T03:00:00Z", "2025-06-10T03:30:00Z", 1, 9), // 2025-06-09
      block("BLOCK-T454", "2025-06-10T10:30:00Z", "2025-06-10T13:00:00Z", 700, 5), // 2025-06-09 → 10
      block("BLOCK-T502", "2025-06-12T03:00:00Z", "2025-06-12T03:30:00Z", 1, 9), // 2025-06-11
    ]);
    fireEvent.click(rect("BLOCK-T501", 1));
    key("ArrowDown"); // onto the crossing block's part on 2025-06-10
    expect(selected()).toEqual(["BLOCK-T454#700"]);
    expect(panel()).toContain("Observation Day: 2025-06-10");
    key("ArrowDown");
    expect(selected()).toEqual(["BLOCK-T502#1"]);
    key("ArrowUp");
    expect(selected()).toEqual(["BLOCK-T454#700"]);
    key("ArrowUp");
    expect(selected()).toEqual(["BLOCK-T501#1"]);

    // From the crossing block's first part, Down skips its own second part.
    fireEvent.click(rects().find((r) => datum(r).program === "BLOCK-T454" && datum(r).day === "2025-06-09")!);
    key("ArrowDown");
    expect(selected()).toEqual(["BLOCK-T502#1"]);
  });

  test("Escape, or a click on empty chart, clears the selection", () => {
    mount();
    fireEvent.click(rect("BLOCK-T1", 10));
    key("Escape");
    expect(selected()).toEqual([]);
    expect(panelTitle()).toBe("Selection Info");
    // The placeholder says how to get around, the arrow keys included.
    expect(panel()).toContain("use the arrow keys to move between blocks");

    fireEvent.click(rect("BLOCK-T1", 10));
    fireEvent.click(root.querySelector(".guide-chart svg")!);
    expect(selected()).toEqual([]);
    expect(panelTitle()).toBe("Selection Info");
  });

  test("arrows are ignored while typing, with search open, or with a program highlighted", () => {
    mount();
    fireEvent.click(rect("BLOCK-T1", 10));
    key("ArrowRight", {}, input());
    expect(selected()).toEqual(["BLOCK-T1#10"]);

    search("block");
    key("ArrowRight");
    expect(selected()).toEqual(["BLOCK-T1#10"]);
    key("Escape", {}, input());

    fireEvent.dblClick(rect("BLOCK-T1", 10));
    key("ArrowRight");
    expect(panelTitle()).toBe("Program Summary");
    expect(selected()).toEqual([]);
  });
});

describe("scrolling", () => {
  test("scrolls today's row to the middle of the app's scroll pane", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2025-04-13T03:00:00Z")); // night of 2025-04-12
    const pane = document.createElement("div");
    pane.className = "app-content";
    pane.scrollTo = vi.fn();
    Object.defineProperty(pane, "clientHeight", { value: 40 });
    document.body.appendChild(pane);
    mount(NIGHTS, {}, pane);
    expect(pane.scrollTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    // The second row starts at 40px (20px margin + one 20px row); its centre
    // (50px) goes to the middle of a 40px pane.
    expect(pane.scrollTo).toHaveBeenCalledWith({ top: 30, behavior: "smooth" });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  const box = (top: number, height: number) =>
    ({ top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  // The chart in a scroll pane that shows 100px of it, the bottom 20px
  // under the floating axes, with each block placed by its row (jsdom has
  // no layout of its own).
  function mountWithLayout(blocks: GuideBlockInput[]) {
    let scrolled = 0;
    const pane = document.createElement("div");
    pane.className = "app-content";
    const scrollTo = vi.fn((opts: ScrollToOptions) => {
      scrolled = opts.top ?? 0;
    });
    pane.scrollTo = scrollTo as unknown as typeof pane.scrollTo;
    Object.defineProperty(pane, "scrollTop", { get: () => scrolled });
    pane.getBoundingClientRect = () => box(0, 100);
    document.body.appendChild(pane);
    mount(blocks, {}, pane);
    root.querySelector(".guide-floating-axis")!.getBoundingClientRect = () => box(80, 20);
    for (const r of rects()) {
      r.getBoundingClientRect = () =>
        box(20 + Number(r.getAttribute("y")) - scrolled, Number(r.getAttribute("height")));
    }
    const inView = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= 80;
    };
    return { pane, scrollTo, inView };
  }

  // One block a night for ten nights, all at 03:00 UTC.
  const COLUMN = Array.from({ length: 10 }, (_, i) => {
    const day = `2025-05-${String(11 + i).padStart(2, "0")}`;
    return block(`BLOCK-T${600 + i}`, `${day}T03:00:00Z`, `${day}T03:30:00Z`, 1, 9);
  });

  test("arrow keys scroll only when the block leaves the view, then bring it to the middle", () => {
    const { scrollTo, inView } = mountWithLayout(COLUMN);
    fireEvent.click(rect("BLOCK-T600", 1));
    const current = () => rects().find((r) => r.classList.contains("selected"))!;
    for (let i = 1; i < 10; i++) {
      key("ArrowDown");
      expect(datum(current()).program).toBe(`BLOCK-T${600 + i}`);
      expect(inView(current())).toBe(true);
    }
    // About every other row: half the 80px that can be seen.
    expect(scrollTo.mock.calls.length).toBe(4);
    const r = current().getBoundingClientRect();
    expect((r.top + r.bottom) / 2).toBeCloseTo(40);
    for (let i = 8; i >= 0; i--) {
      key("ArrowUp");
      expect(datum(current()).program).toBe(`BLOCK-T${600 + i}`);
      expect(inView(current())).toBe(true);
    }
  });

  test("picking a one-block program from search scrolls to that block", () => {
    const { scrollTo } = mountWithLayout(COLUMN);
    const r = rect("BLOCK-T609", 1).getBoundingClientRect();
    search("T609");
    fireEvent.click(resultItems()[0]);
    expect(selected()).toEqual(["BLOCK-T609#1"]);
    // Its row centred in the 100px pane.
    expect(scrollTo.mock.calls.at(-1)![0].top).toBeCloseTo(r.top - 50);
  });

  test("a pane that can't scroll is ignored", () => {
    const { pane } = mountWithLayout(COLUMN);
    pane.scrollTo = () => {
      throw new Error("not scrollable");
    };
    fireEvent.click(rect("BLOCK-T602", 1));
    key("ArrowDown"); // out of view, so it tries
    expect(selected()).toEqual(["BLOCK-T603#1"]);
  });
});

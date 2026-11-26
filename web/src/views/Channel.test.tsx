import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { queryKeys } from "../lib/liveQuery";
import { createQueryClient } from "../lib/queryClient";
import { DISCONNECT_GRACE_MS, LiveProvider } from "../lib/LiveContext";
import { routes } from "../routes";
import { LIVE_LAG_CUE_MS, LIVE_LOAD_LIMIT_MS } from "./Channel";
import {
  liveSockets,
  loseLiveConnection,
  openLiveSockets,
  pushLiveMessage,
  reconnectLive,
  wholeMetadata,
} from "../test-setup";

// The single-channel viewer's own interactions: arrow keys step through the
// night's exposures and Shift+arrows through the channels that share one,
// click-to-zoom on a tall image, videos, and the folded metadata rail. Route
// resolution, the sibling strip and the loading spinner are in routes.test.

const CHANNELS = [
  { name: "monitor", title: "Monitor", per_day: false },
  { name: "imexam", title: "ImExam", per_day: false },
  { name: "spec", title: "Spectrum", per_day: false },
  { name: "movie", title: "Movie", per_day: false },
];

// Seqs 5, 7 and 9 on monitor (more can land, see `land`); imexam and spec
// share 7; movie is a video.
let monitorSeqs = [9, 5, 7];
// Monitor seqs whose file is a movie, not an image.
let movieSeqs: number[] = [];
function stub() {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith("/api/locations")) {
      body = [{ name: "local", title: "Local" }];
    } else if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: ["2026-04-10"] };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = {
        name: "auxtel",
        title: "AuxTel",
        channels: CHANNELS,
        metadata_columns: {},
      };
    } else if (/\/metadata\//.test(url)) {
      body = wholeMetadata({ "7": { Exposure: 30 } });
    } else if (/\/dates\//.test(url)) {
      body = {
        per_day: {},
        metadata: {},
        channels: {
          monitor: [...monitorSeqs],
          imexam: [7],
          spec: [7],
          movie: [3, 4],
        },
        extensions: {
          monitor: {
            default: "png",
            exceptions: Object.fromEntries(movieSeqs.map((s) => [s, "mp4"])),
          },
          imexam: { default: "png", exceptions: {} },
          spec: { default: "png", exceptions: {} },
          movie: { default: "mp4", exceptions: {} },
        },
      };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  monitorSeqs = [9, 5, 7];
  movieSeqs = [];
  stub();
  localStorage.removeItem("rubintv.channel.metaCollapsed");
});

// The rendered page's query client, for a test that needs to see what the
// page has fetched.
let client: QueryClient;
function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>,
  );
  return router;
}

const where = (router: ReturnType<typeof renderAt>) =>
  router.state.location.pathname + router.state.location.search;
// fireEvent returns false when a handler called preventDefault.
const press = (key: string, shiftKey = false) =>
  fireEvent.keyDown(window, { key, shiftKey });

test("arrow keys step to the previous and next exposure", async () => {
  const router = renderAt("/local/auxtel/monitor?seq=7&date=2026-04-10");
  await screen.findByRole("link", { name: "Next (9)" });

  expect(press("ArrowRight")).toBe(false);
  await waitFor(() =>
    expect(where(router)).toBe("/local/auxtel/monitor?seq=9&date=2026-04-10"),
  );
  await screen.findByRole("link", { name: "Previous (7)" });

  expect(press("ArrowLeft")).toBe(false);
  await waitFor(() =>
    expect(where(router)).toBe("/local/auxtel/monitor?seq=7&date=2026-04-10"),
  );
  await screen.findByRole("link", { name: "Previous (5)" });
  press("ArrowLeft");
  await waitFor(() =>
    expect(where(router)).toBe("/local/auxtel/monitor?seq=5&date=2026-04-10"),
  );
});

test("at the ends of the night the arrows do nothing, and leave the page be", async () => {
  const router = renderAt("/local/auxtel/monitor?seq=9&date=2026-04-10");
  await screen.findByRole("link", { name: "Previous (7)" });
  // Not acted on, so not prevented: the browser keeps its own behaviour.
  expect(press("ArrowRight")).toBe(true);
  expect(press("ArrowUp")).toBe(true);
  expect(where(router)).toBe("/local/auxtel/monitor?seq=9&date=2026-04-10");
});

test("the arrows stand down under a modal, and with ⌘ held", async () => {
  const router = renderAt("/local/auxtel/monitor?seq=7&date=2026-04-10");
  await screen.findByRole("link", { name: "Next (9)" });
  // ⌘→ is the browser's Forward.
  expect(fireEvent.keyDown(window, { key: "ArrowRight", metaKey: true })).toBe(true);
  // The shortcuts panel (or a cell's details) is up over the page.
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  expect(press("ArrowRight")).toBe(true);
  modal.remove();
  expect(where(router)).toBe("/local/auxtel/monitor?seq=7&date=2026-04-10");
});

test("Shift+arrows step through the channels that share this exposure", async () => {
  const router = renderAt("/local/auxtel/imexam?seq=7&date=2026-04-10");
  await screen.findByRole("navigation", { name: "Channels for this exposure" });

  // Shift+Arrow is the browser's extend-selection key: it must be prevented.
  expect(press("ArrowRight", true)).toBe(false);
  await waitFor(() =>
    expect(where(router)).toBe("/local/auxtel/spec?seq=7&date=2026-04-10"),
  );
  // spec is the last sibling: no further.
  await screen.findByRole("link", { name: "ImExam" });
  expect(press("ArrowRight", true)).toBe(true);

  expect(press("ArrowLeft", true)).toBe(false);
  await waitFor(() =>
    expect(where(router)).toBe("/local/auxtel/imexam?seq=7&date=2026-04-10"),
  );
  await screen.findByRole("link", { name: "Spectrum" });
  press("ArrowLeft", true);
  await waitFor(() =>
    expect(where(router)).toBe("/local/auxtel/monitor?seq=7&date=2026-04-10"),
  );
  // monitor is the first: Shift+Left does nothing.
  await screen.findByRole("link", { name: "ImExam" });
  expect(press("ArrowLeft", true)).toBe(true);
});

test("a dated link without a seq opens that night's newest exposure", async () => {
  renderAt("/local/auxtel/monitor?date=2026-04-10");
  expect(await screen.findByRole("img", { name: "monitor 9" })).toBeDefined();
});

test("a video channel plays its file, with no image link or spinner", async () => {
  renderAt("/local/auxtel/movie?seq=4&date=2026-04-10");
  await screen.findByRole("link", { name: "Previous (3)" });
  expect(document.querySelector("video")).not.toBeNull();
  expect(screen.queryByRole("link", { name: "Open image in new tab" })).toBeNull();
  expect(screen.queryByRole("status", { name: "Loading image" })).toBeNull();
});

test("live mode on a video channel shows the newest one straight away", async () => {
  renderAt("/local/auxtel/movie/current");
  await screen.findByText("LIVE");
  await waitFor(() =>
    expect(document.querySelector(".seq-current")?.textContent).toBe("4"),
  );
  expect(document.querySelector("video")).not.toBeNull();
});

test("live mode stops calling itself LIVE while the tab is disconnected", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    renderAt("/local/auxtel/movie/current");
    act(() => openLiveSockets());
    const badge = await screen.findByText("LIVE");
    expect(badge.className).toContain("live");
    await waitFor(() => expect(document.title).toContain("· LIVE ·"));

    // Nothing newer can arrive, so the badge and the tab's title say so.
    loseLiveConnection(DISCONNECT_GRACE_MS);
    expect(screen.queryByText("LIVE")).toBeNull();
    const stalled = screen.getByText("DISCONNECTED");
    expect(stalled.className).toContain("stalled");
    expect(stalled.getAttribute("title")).toMatch(/not following new data/);
    expect(document.title).toContain("· DISCONNECTED ·");

    act(() => liveSockets().at(-1)!.onopen?.());
    expect(screen.getByText("LIVE")).toBeDefined();
    expect(document.title).toContain("· LIVE ·");
  } finally {
    vi.useRealTimers();
  }
});

describe("live mode's hold on the frame in view", () => {
  // The viewer loads the next frame off screen (new Image()) and swaps it in
  // once decoded. jsdom loads no images, so stand in for those: each records
  // the URL it was given, and its decode() settles only when the test says
  // so, or fails as a browser's does when the src is taken away.
  class OffscreenImage {
    static made: OffscreenImage[] = [];
    private url = "";
    settle: { ok: () => void; fail: () => void } | null = null;
    constructor() {
      OffscreenImage.made.push(this);
    }
    get src() {
      return this.url;
    }
    set src(url: string) {
      this.url = url;
      if (url === "") this.settle?.fail();
    }
    decode() {
      return new Promise<void>((ok, fail) => {
        this.settle = { ok, fail: () => fail(new Error("src cleared")) };
      });
    }
    decoded() {
      this.settle?.ok();
    }
  }
  const urlOf = (seq: number) => `/${String(seq).padStart(6, "0")}/image.png`;
  // The frames loaded to take the place of the one in view, in the order
  // asked for, without any given up since (their src cleared). The viewer
  // also warms the browser's cache with the frames either side of the one in
  // view; those it never waits on, so decode() tells the two apart.
  const held = () => OffscreenImage.made.filter((img) => img.settle !== null);
  const loading = () =>
    held()
      .filter((img) => img.src !== "")
      .map((img) => Number(/\/(\d{6})\/image\.png$/.exec(img.src)?.[1]));
  const offscreen = (seq: number) =>
    held().filter((img) => img.src.endsWith(urlOf(seq))).at(-1)!;
  const decoded = (seq: number) => act(async () => offscreen(seq).decoded());
  const shown = () => document.querySelector(".seq-current")?.textContent;

  // A new exposure lands on the monitor channel, the tab hears of it, and
  // the view has the night's new list.
  async function land(seq: number) {
    monitorSeqs = [...monitorSeqs, seq];
    act(() =>
      pushLiveMessage({
        type: "channelData",
        location: "local",
        camera: "auxtel",
        date: "2026-04-10",
      }),
    );
    const night = queryKeys.datePayload("local", "auxtel", "2026-04-10");
    await waitFor(() =>
      expect(
        client.getQueryData<{ channels: { monitor: number[] } }>(night)
          ?.channels.monitor,
      ).toEqual(monitorSeqs),
    );
    // The query tells the view on a zero timer; let that run, and the view
    // act on the new list.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }

  beforeEach(() => {
    OffscreenImage.made = [];
    vi.stubGlobal("Image", OffscreenImage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("the frame in view stays, label and links with it, until the next has decoded", async () => {
    renderAt("/local/auxtel/monitor/current");
    await screen.findByRole("img", { name: "monitor 9" });
    // The first frame goes straight to the page: nothing to hold in its place.
    expect(loading()).toEqual([]);

    await land(11);
    expect(shown()).toBe("9");
    expect(screen.getByRole("img", { name: "monitor 9" })).toBeDefined();
    // No way forward yet to a frame that isn't on screen.
    expect(screen.queryByRole("link", { name: /^Next/ })).toBeNull();

    await decoded(11);
    expect(shown()).toBe("11");
    expect(screen.getByRole("img", { name: "monitor 11" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Previous (9)" })).toBeDefined();
  });

  test("frames that land faster than they load still reach the page, one at a time", async () => {
    renderAt("/local/auxtel/monitor/current");
    await screen.findByRole("img", { name: "monitor 9" });

    // 11 is still on its way when 12 lands, and 13 after it: it is left to
    // finish, with nothing else started beside it.
    await land(11);
    await land(12);
    await land(13);
    expect(loading()).toEqual([11]);
    expect(shown()).toBe("9");

    // It reaches the page though it is no longer the newest, and the next
    // load is the newest by then, not each frame in between.
    await decoded(11);
    expect(shown()).toBe("11");
    expect(loading()).toEqual([11, 13]);
    expect(screen.queryByRole("link", { name: /^Next/ })).toBeNull();

    await land(14);
    await decoded(13);
    expect(shown()).toBe("13");
    // The frame before it was skipped, and isn't fetched for the Previous
    // link alongside the one being waited for.
    const warmed = (seq: number) =>
      OffscreenImage.made.some(
        (img) => img.settle === null && img.src.endsWith(urlOf(seq)),
      );
    expect(warmed(12)).toBe(false);

    await decoded(14);
    expect(shown()).toBe("14");
    expect(screen.getByText("LIVE")).toBeDefined();
    // Caught up: now the frame before is made ready.
    expect(warmed(13)).toBe(true);
    expect(warmed(12)).toBe(false);
  });

  test("a frame that fails to decode still takes its turn", async () => {
    // Its <img> on the page then recovers what it can (see ProxiedImg).
    const failed = vi.spyOn(OffscreenImage.prototype, "decode");
    failed.mockRejectedValue(new Error("no such image"));
    renderAt("/local/auxtel/monitor/current");
    await screen.findByRole("img", { name: "monitor 9" });
    await land(11);
    await waitFor(() => expect(shown()).toBe("11"));
  });

  test("without decode() the swap goes by the image's load", async () => {
    // As in jsdom, and in a browser too old to have it.
    const made: Array<{ src: string; onload: (() => void) | null }> = [];
    class PlainImage {
      src = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        made.push(this);
      }
    }
    vi.stubGlobal("Image", PlainImage);
    const router = renderAt("/local/auxtel/monitor/current");
    await screen.findByRole("img", { name: "monitor 9" });
    await land(11);
    expect(shown()).toBe("9");
    const next = made.find((img) => img.onload !== null)!;
    expect(next.src.endsWith(urlOf(11))).toBe(true);
    act(() => next.onload!());
    expect(shown()).toBe("11");

    // One given up is stopped, and no longer listened to.
    await land(12);
    const dropped = made.find((img) => img.src.endsWith(urlOf(12)))!;
    expect(dropped.onload).not.toBeNull();
    await act(() => router.navigate("/local/auxtel/monitor?seq=5&date=2026-04-10"));
    expect(dropped.src).toBe("");
    expect(dropped.onload).toBeNull();
  });

  test("a reconnect gives up the load under way and starts it afresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt("/local/auxtel/monitor/current");
      act(() => openLiveSockets());
      await screen.findByRole("img", { name: "monitor 9" });
      await land(11);
      const hung = offscreen(11);

      // Over a connection that died without closing, that load would hang for
      // minutes and hold every later frame behind it.
      reconnectLive();
      expect(hung.src).toBe("");
      expect(loading()).toEqual([11]);
      expect(offscreen(11)).not.toBe(hung);
      expect(shown()).toBe("9");

      await decoded(11);
      expect(shown()).toBe("11");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a load that runs out of time is given up for the newest frame", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt("/local/auxtel/monitor/current");
      await screen.findByRole("img", { name: "monitor 9" });
      await land(11);
      const stuck = offscreen(11);
      await land(12);

      // Just short of the limit it is still waited for.
      act(() => {
        vi.advanceTimersByTime(LIVE_LOAD_LIMIT_MS - 1000);
      });
      expect(loading()).toEqual([11]);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(stuck.src).toBe("");
      expect(loading()).toEqual([12]);
      expect(shown()).toBe("9");
      await decoded(12);
      expect(shown()).toBe("12");
    } finally {
      vi.useRealTimers();
    }
  });

  test("with nothing newer, a load that runs out of time is tried again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt("/local/auxtel/monitor/current");
      await screen.findByRole("img", { name: "monitor 9" });
      await land(11);
      const stuck = offscreen(11);
      act(() => {
        vi.advanceTimersByTime(LIVE_LOAD_LIMIT_MS);
      });
      expect(stuck.src).toBe("");
      expect(loading()).toEqual([11]);
      const again = offscreen(11);
      expect(again).not.toBe(stuck);

      // The second try has its own full time, and one that arrives is no
      // longer on the clock.
      act(() => {
        vi.advanceTimersByTime(LIVE_LOAD_LIMIT_MS - 1000);
      });
      await decoded(11);
      expect(shown()).toBe("11");
      act(() => {
        vi.advanceTimersByTime(LIVE_LOAD_LIMIT_MS);
      });
      expect(again.src).not.toBe("");
      expect(shown()).toBe("11");
    } finally {
      vi.useRealTimers();
    }
  });

  // The seq nav's note of the frame being waited for.
  const awaited = () =>
    screen.queryByRole("status", { name: /^Loading exposure/ });
  const pass = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  test("a view left behind says which frame it is waiting on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt("/local/auxtel/monitor/current");
      await screen.findByRole("img", { name: "monitor 9" });
      await land(11);
      expect(awaited()).toBeNull();

      pass(LIVE_LAG_CUE_MS);
      expect(awaited()?.textContent).toBe("11");
      expect(awaited()?.getAttribute("aria-label")).toBe("Loading exposure 11");
      // In the Next link's place; the view is still following.
      expect(awaited()?.closest("nav")?.className).toBe("seq-nav");
      expect(screen.getByText("LIVE")).toBeDefined();

      // Still behind once that one is in: the note moves on to the next.
      await land(12);
      await decoded(11);
      expect(shown()).toBe("11");
      expect(awaited()?.textContent).toBe("12");

      await decoded(12);
      expect(shown()).toBe("12");
      expect(awaited()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a frame that loads in good time is never announced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt("/local/auxtel/monitor/current");
      await screen.findByRole("img", { name: "monitor 9" });
      await land(11);
      pass(LIVE_LAG_CUE_MS - 500);
      await decoded(11);
      pass(LIVE_LAG_CUE_MS);
      expect(awaited()).toBeNull();

      // The next frame's wait is counted from its own start.
      await land(12);
      pass(LIVE_LAG_CUE_MS - 500);
      expect(awaited()).toBeNull();
      pass(500);
      expect(awaited()?.textContent).toBe("12");
    } finally {
      vi.useRealTimers();
    }
  });

  test("stepping back gives up the load under way, and Jump to current starts from the newest", async () => {
    const router = renderAt("/local/auxtel/monitor/current");
    await screen.findByRole("img", { name: "monitor 9" });
    await land(11);
    const dropped = offscreen(11);

    await act(() => router.navigate("/local/auxtel/monitor?seq=5&date=2026-04-10"));
    await screen.findByRole("img", { name: "monitor 5" });
    expect(dropped.src).toBe("");

    // Not the frame the earlier spell of following had got to.
    await act(() => router.navigate("/local/auxtel/monitor/current"));
    expect(shown()).toBe("11");
    expect(screen.getByRole("img", { name: "monitor 11" })).toBeDefined();
  });

  test("leaving the page gives up the load under way", async () => {
    const router = renderAt("/local/auxtel/monitor/current");
    await screen.findByRole("img", { name: "monitor 9" });
    await land(11);
    await act(() => router.navigate("/local/auxtel"));
    expect(held().length).toBe(1);
    expect(loading()).toEqual([]);
  });

  test("a newest frame that is taken away is not waited for", async () => {
    renderAt("/local/auxtel/monitor/current");
    await screen.findByRole("img", { name: "monitor 9" });
    await land(11);
    const gone = offscreen(11);

    // A rescan drops 11 (the night's list can change) as 10 turns up.
    monitorSeqs = [9, 5, 7];
    await land(10);
    expect(gone.src).toBe("");
    expect(loading()).toEqual([10]);
    await decoded(10);
    expect(shown()).toBe("10");
  });

  test("a movie among the frames is shown at once", async () => {
    movieSeqs = [12];
    renderAt("/local/auxtel/monitor/current");
    await screen.findByRole("img", { name: "monitor 9" });
    await land(11);
    await land(12);
    expect(shown()).toBe("12");
    expect(document.querySelector("video")).not.toBeNull();
    // The image that was on its way has nothing left to do.
    expect(loading()).toEqual([]);
  });
});

test("a broken image clears the loading spinner too", async () => {
  renderAt("/local/auxtel/monitor?seq=7&date=2026-04-10");
  const img = await screen.findByRole("img", { name: "monitor 7" });
  expect(screen.getByRole("status", { name: "Loading image" })).toBeDefined();
  fireEvent.error(img);
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "Loading image" })).toBeNull(),
  );
});

test("the folded metadata rail reopens the panel", async () => {
  localStorage.setItem("rubintv.channel.metaCollapsed", "true");
  renderAt("/local/auxtel/monitor?seq=7&date=2026-04-10");
  fireEvent.click(
    await screen.findByRole("button", { name: "Show exposure metadata" }),
  );
  expect(await screen.findByText("30")).toBeDefined();
  expect(localStorage.getItem("rubintv.channel.metaCollapsed")).toBe("false");
});

describe("click to zoom", () => {
  // jsdom has no layout: give the image a natural size and its frame a box.
  // A 1000×2000 image at the frame's 500px width fills 1000px of a 600px
  // frame, so it overflows and can be shrunk to fit.
  let frameHeight = 600;
  const defs: Array<[object, string, PropertyDescriptor | undefined]> = [];
  function define(proto: object, prop: string, get: () => number) {
    defs.push([proto, prop, Object.getOwnPropertyDescriptor(proto, prop)]);
    Object.defineProperty(proto, prop, { configurable: true, get });
  }
  beforeEach(() => {
    frameHeight = 600;
    define(HTMLImageElement.prototype, "naturalWidth", () => 1000);
    define(HTMLImageElement.prototype, "naturalHeight", () => 2000);
    define(Element.prototype, "clientWidth", () => 500);
    define(Element.prototype, "clientHeight", () => frameHeight);
    define(Element.prototype, "scrollHeight", () => 1000);
  });
  afterEach(() => {
    for (const [proto, prop, desc] of defs.reverse()) {
      if (desc) Object.defineProperty(proto, prop, desc);
      else delete (proto as Record<string, unknown>)[prop];
    }
    defs.length = 0;
    vi.restoreAllMocks();
  });

  const frame = () => document.querySelector<HTMLElement>(".chv-frame")!;

  test("a tall image toggles between fill and fit, keeping the clicked point", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    renderAt("/local/auxtel/monitor?seq=7&date=2026-04-10");
    const img = await screen.findByRole("img", { name: "monitor 7" });
    fireEvent.load(img);
    await waitFor(() => expect(frame().className).toContain("chv-zoomable"));
    expect(frame().className).toContain("chv-zoom-fill");

    fireEvent.click(img);
    expect(frame().className).toContain("chv-zoom-fit");

    // Clicking 3/4 of the way down the shrunk image, 150px into the frame,
    // re-enlarges with that point (750px of 1000) back under the cursor.
    img.getBoundingClientRect = () => ({ top: 100, height: 400 }) as DOMRect;
    frame().getBoundingClientRect = () => ({ top: 350 }) as DOMRect;
    fireEvent.click(img, { clientY: 400 });
    expect(frame().className).toContain("chv-zoom-fill");
    expect(frame().scrollTop).toBe(750 - 50);
  });

  test("an image that already fits has nothing to zoom", async () => {
    frameHeight = 1200;
    renderAt("/local/auxtel/monitor?seq=7&date=2026-04-10");
    const img = await screen.findByRole("img", { name: "monitor 7" });
    fireEvent.load(img);
    await act(async () => {});
    expect(frame().className).not.toContain("chv-zoomable");
    fireEvent.click(img);
    expect(frame().className).toContain("chv-zoom-fill");
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { routes } from "../routes";

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

// Seqs 5, 7 and 9 on monitor; imexam and spec share 7; movie is a video.
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
      body = { "7": { Exposure: 30 } };
    } else if (/\/dates\//.test(url)) {
      body = {
        per_day: {},
        metadata: {},
        channels: { monitor: [9, 5, 7], imexam: [7], spec: [7], movie: [3, 4] },
        extensions: {
          monitor: { default: "png", exceptions: {} },
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
  stub();
  localStorage.removeItem("rubintv.channel.metaCollapsed");
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
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

test("live mode promotes a new image once it has decoded", async () => {
  // A browser with img.decode(): the newest frame is shown once it resolves.
  const decode = vi.fn().mockResolvedValue(undefined);
  HTMLImageElement.prototype.decode = decode;
  try {
    renderAt("/local/auxtel/monitor/current");
    await waitFor(() =>
      expect(document.querySelector(".seq-current")?.textContent).toBe("9"),
    );
    expect(decode).toHaveBeenCalled();
  } finally {
    // @ts-expect-error - jsdom has no decode; put it back that way.
    delete HTMLImageElement.prototype.decode;
  }
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

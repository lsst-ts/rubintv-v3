import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient, currentDayObs } from "../lib/queryClient";
import { DISCONNECT_GRACE_MS, LiveProvider } from "../lib/LiveContext";
import {
  liveSockets,
  loseLiveConnection,
  openLiveSockets,
  pushLiveMessage,
} from "../test-setup";
import type { CameraOut } from "../lib/types";
import { tabsForCamera } from "../lib/useShellNav";
import { routes } from "../routes";

// The shell reads the location/camera from the URL, so a bare fetch stub is
// enough — the header banner and env strip derive from the route + hostname,
// not from fetched config.
beforeEach(() => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/api/locations")
      ? []
      : {
          dates: [],
          values: {},
          camera_groups: [],
          channels: [],
          per_day: {},
          metadata: {},
          detectors: [],
          menus: [],
        };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>,
  );
}

test("USDF LSSTCam shows the nightly-validation processing banner", async () => {
  renderAt("/usdf/lsstcam");
  expect(
    await screen.findByText("USDF Nightly Validation Processing"),
  ).toBeDefined();
});

test("summit LSSTCamAOS shows the quicklook processing banner", async () => {
  renderAt("/summit/lsstcam_aos");
  expect(
    await screen.findByText("Summit Quicklook Processing"),
  ).toBeDefined();
});

test("no processing banner on a non-LSSTCam camera", async () => {
  renderAt("/usdf/auxtel");
  // Wait for the shell to settle (the breadcrumb leaf marks the camera route),
  // then assert neither processing banner rendered.
  expect(
    await screen.findByRole("link", { name: "usdf" }),
  ).toBeDefined();
  expect(screen.queryByText(/Processing/)).toBeNull();
});

test("no processing banner on a location without one", async () => {
  renderAt("/base-usdf/lsstcam");
  expect(
    await screen.findByRole("link", { name: "base-usdf" }),
  ).toBeDefined();
  expect(screen.queryByText(/Processing/)).toBeNull();
});

test("localhost renders the environment warning strip", async () => {
  // jsdom's default href is http://localhost/, so instanceEnv() reads
  // "localhost" without any stubbing.
  renderAt("/usdf/lsstcam");
  expect(await screen.findByText("Localhost — development server")).toBeDefined();
  expect(screen.getByText("LOCAL")).toBeDefined();
});

test("the backend test site labels the strip TEST", async () => {
  // /api/config reports the deployment site; a non-prod site overrides the
  // hostname heuristic in the strip's label.
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/api/config")
      ? { site: "test" }
      : url.endsWith("/api/locations")
        ? []
        : { camera_groups: [], channels: [], dates: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;

  renderAt("/usdf/lsstcam");
  expect(await screen.findByText("Test instance")).toBeDefined();
  expect(screen.getByText("TEST")).toBeDefined();
});

test("the topbar publishes its height for the table to hide it by", async () => {
  // jsdom has no layout: give the topbar a height, and run the observer's
  // callback on observe, as a browser does once the element is laid out.
  class ImmediateResizeObserver {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe() {
      this.cb([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  const height = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("topbar") ? 132 : 0;
    });

  const { container } = renderAt("/usdf/auxtel");
  await screen.findByRole("link", { name: "usdf" });
  const main = container.querySelector<HTMLElement>(".main")!;
  expect(main.style.getPropertyValue("--topbar-h")).toBe("132px");
  height.mockRestore();
});

// Leave the tab's connection down past the grace the shell allows a blip.
const loseConnection = () => loseLiveConnection(DISCONNECT_GRACE_MS);

test("a tab whose connection is down says so, and stops calling the day live", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const today = currentDayObs();
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith("/api/locations")) {
      body = [{ name: "local", title: "Local" }];
    } else if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: [today] };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = { name: "auxtel", title: "AuxTel", channels: [], metadata_columns: {} };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels: {}, extensions: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
  try {
    renderAt("/local/auxtel");
    act(() => openLiveSockets());
    const chip = await screen.findByRole("button", { name: today });
    expect(chip.className).toContain("is-live-day");
    expect(screen.queryByText("Disconnected")).toBeNull();

    loseConnection();
    expect(screen.getByText("Disconnected").closest(".topbar-status")).not.toBeNull();
    expect(chip.className).toContain("is-stalled-day");
    expect(chip.getAttribute("title")).toMatch(/not updating/);

    // The retry that gets through clears both.
    act(() => liveSockets().at(-1)!.onopen?.());
    expect(screen.queryByText("Disconnected")).toBeNull();
    expect(chip.className).toContain("is-live-day");
  } finally {
    vi.useRealTimers();
  }
});

test("the current day says what time its data is as of; a past day doesn't", async () => {
  // Only today's prefixes are polled every second, so only today's data has
  // a moment it is current to.
  const today = currentDayObs();
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith("/api/locations")) {
      body = [{ name: "local", title: "Local" }];
    } else if (url.endsWith("/api/health/status")) {
      body = { last_poll_age_seconds: 2, cameras: [] };
    } else if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: [today, "2026-01-05"] };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = { name: "auxtel", title: "AuxTel", channels: [], metadata_columns: {} };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels: {}, extensions: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
  const live = renderAt("/local/auxtel");
  await screen.findByRole("button", { name: today });
  const label = await screen.findByText(/^as of \d\d:\d\d:\d\d UTC$/);
  expect(label.closest(".title-row")).not.toBeNull();
  live.unmount();

  renderAt("/local/auxtel?date=2026-01-05");
  await screen.findByRole("button", { name: "2026-01-05" });
  await waitFor(() => expect(document.querySelector(".is-past-day")).not.toBeNull());
  expect(screen.queryByText(/^as of/)).toBeNull();
});

test("a headerless embed has no topbar, so a warning triangle stands for its notice", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // The shell's own, pinned to the corner (the camera table carries another
  // in its toolbar, which the CSS shows in this one's place).
  const mark = (within: HTMLElement) =>
    within.querySelector<HTMLElement>(".shell.headerless > .conn-mark");
  try {
    const embed = renderAt("/usdf/auxtel?headerless=true");
    act(() => openLiveSockets());
    expect(mark(embed.container)).toBeNull();
    loseConnection();
    expect(mark(embed.container)!.getAttribute("aria-label")).toMatch(
      /^Disconnected: this view has lost its live connection/,
    );
    expect(embed.container.querySelector(".topbar")).toBeNull();
    act(() => liveSockets().at(-1)!.onopen?.());
    expect(mark(embed.container)).toBeNull();
    embed.unmount();

    // The full shell has the topbar's notice, and no corner triangle.
    const shell = renderAt("/usdf/auxtel");
    act(() => openLiveSockets());
    await screen.findByRole("link", { name: "usdf" });
    loseConnection();
    expect(screen.getByText("Disconnected")).toBeDefined();
    expect(shell.container.querySelector(".conn-mark:not(.conn-mark--inline)")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("the status page reports the connection itself, so the topbar leaves it to it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    renderAt("/status");
    act(() => openLiveSockets());
    expect(await screen.findByText("WebSocket connected")).toBeDefined();
    loseConnection();
    expect(screen.getByText(/^WebSocket (connecting…|disconnected)$/)).toBeDefined();
    expect(screen.queryByText("Disconnected")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("the next-day stepper moves to the following day with data", async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith("/api/locations")) {
      body = [{ name: "local", title: "Local" }];
    } else if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: ["2026-04-10", "2026-04-08", "2026-04-05"] };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = { name: "auxtel", title: "AuxTel", channels: [], metadata_columns: {} };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels: {}, extensions: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
  const router = createMemoryRouter(routes, {
    initialEntries: ["/local/auxtel?date=2026-04-05"],
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>,
  );
  // From the oldest date, "next" skips the empty days to 04-08.
  const next = await screen.findByRole("button", { name: /Next day with data/ });
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(next);
  await waitFor(() =>
    expect(router.state.location.search).toContain("date=2026-04-08"),
  );
});

test("[ and ] step the day as the stepper buttons do, but not while typing", async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith("/api/locations")) {
      body = [{ name: "local", title: "Local" }];
    } else if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: ["2026-04-10", "2026-04-08", "2026-04-05"] };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = { name: "auxtel", title: "AuxTel", channels: [], metadata_columns: {} };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels: {}, extensions: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
  const router = createMemoryRouter(routes, {
    initialEntries: ["/local/auxtel?date=2026-04-08"],
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>,
  );
  const date = () => router.state.location.search;
  const next = await screen.findByRole("button", { name: /Next day with data/ });
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
  // The buttons name their keys.
  expect(next.getAttribute("title")).toBe("Next day with data (])");
  expect(next.getAttribute("aria-keyshortcuts")).toBe("]");

  // Onto the newest day, which the URL leaves unnamed (see the tests of the
  // Table following the night, below).
  expect(fireEvent.keyDown(document.body, { key: "]" })).toBe(false);
  await waitFor(() => expect(date()).toBe(""));
  fireEvent.keyDown(document.body, { key: "[" });
  await waitFor(() => expect(date()).toContain("date=2026-04-08"));

  // ⌘[ is the browser's Back, and a [ typed into a field is text.
  expect(fireEvent.keyDown(document.body, { key: "[", metaKey: true })).toBe(true);
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  expect(fireEvent.keyDown(field, { key: "[" })).toBe(true);
  field.remove();
  expect(date()).toContain("date=2026-04-08");
});

test("[ and ] do nothing in a headerless embed, which has no stepper", async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith("/api/locations")) {
      body = [{ name: "local", title: "Local" }];
    } else if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: ["2026-04-10", "2026-04-08"] };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = { name: "auxtel", title: "AuxTel", channels: [], metadata_columns: {} };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels: {}, extensions: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
  const router = createMemoryRouter(routes, {
    initialEntries: ["/local/auxtel?date=2026-04-08&headerless=true"],
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("No data for 2026-04-08.");
  expect(fireEvent.keyDown(document.body, { key: "]" })).toBe(true);
  expect(router.state.location.search).toContain("date=2026-04-08");
});

// A Table with no ?date= in its URL shows the newest night and moves on to the
// next one when it starts. Naming tonight in the URL would hold the page on
// tonight, so nothing in the shell writes the newest date into a Table URL.
function stubFollowingCamera(dates: () => string[]) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith("/api/locations")) {
      body = [{ name: "local", title: "Local" }];
    } else if (/\/cameras\/lsstcam\/calendar$/.test(url)) {
      body = { dates: dates() };
    } else if (/\/cameras\/lsstcam$/.test(url)) {
      body = {
        name: "lsstcam",
        title: "LSSTCam",
        channels: [{ name: "monitor", title: "Monitor", per_day: false }],
        metadata_columns: {},
      };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels: {}, extensions: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

function renderRouterAt(path: string) {
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

const urlOf = (router: ReturnType<typeof createMemoryRouter>) =>
  router.state.location.pathname + router.state.location.search;

const nextNightLands = (date: string) =>
  act(() =>
    pushLiveMessage({
      type: "calendarUpdate",
      location: "local",
      camera: "lsstcam",
      date,
    }),
  );

test("a trip to Channels and back leaves the Table following the next night", async () => {
  let dates = ["2026-04-10", "2026-04-08"];
  stubFollowingCamera(() => dates);
  const router = renderRouterAt("/local/lsstcam");

  fireEvent.click(await screen.findByRole("link", { name: /^Channels/ }));
  await waitFor(() => expect(urlOf(router)).toBe("/local/lsstcam/channels"));
  fireEvent.click(screen.getByRole("link", { name: "Table" }));
  await waitFor(() => expect(urlOf(router)).toBe("/local/lsstcam"));
  await screen.findByRole("button", { name: "2026-04-10" });

  // The next night's first data: the Table moves on to it.
  dates = ["2026-04-11", ...dates];
  nextNightLands("2026-04-11");
  await screen.findByRole("button", { name: "2026-04-11" });
  expect(urlOf(router)).toBe("/local/lsstcam");
});

test("a link that names the newest night doesn't pass the date on to the tabs", async () => {
  stubFollowingCamera(() => ["2026-04-10", "2026-04-08"]);
  renderRouterAt("/local/lsstcam?date=2026-04-10");
  const channels = await screen.findByRole("link", { name: /^Channels/ });
  await waitFor(() =>
    expect(channels.getAttribute("href")).toBe("/local/lsstcam/channels"),
  );
  expect(screen.getByRole("link", { name: "Table" }).getAttribute("href")).toBe(
    "/local/lsstcam",
  );
});

test("the tabs keep an earlier night in view", async () => {
  stubFollowingCamera(() => ["2026-04-10", "2026-04-08"]);
  renderRouterAt("/local/lsstcam?date=2026-04-08");
  const channels = await screen.findByRole("link", { name: /^Channels/ });
  expect(channels.getAttribute("href")).toBe(
    "/local/lsstcam/channels?date=2026-04-08",
  );
  expect(screen.getByRole("link", { name: "Table" }).getAttribute("href")).toBe(
    "/local/lsstcam?date=2026-04-08",
  );
});

test("stepping forward onto the newest night goes back to following", async () => {
  let dates = ["2026-04-10", "2026-04-08"];
  stubFollowingCamera(() => dates);
  // Another param on the URL is kept; only the date goes.
  const router = renderRouterAt("/local/lsstcam?date=2026-04-08&seq_filter=1-5");
  const next = await screen.findByRole("button", { name: /Next day with data/ });
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(next);
  await waitFor(() =>
    expect(urlOf(router)).toBe("/local/lsstcam?seq_filter=1-5"),
  );
  await screen.findByRole("button", { name: "2026-04-10" });

  dates = ["2026-04-11", ...dates];
  nextNightLands("2026-04-11");
  await screen.findByRole("button", { name: "2026-04-11" });
});

test("picking the newest night from Channels opens the Table following it", async () => {
  stubFollowingCamera(() => ["2026-04-10", "2026-04-08"]);
  const router = renderRouterAt("/local/lsstcam/channels?date=2026-04-08");
  const next = await screen.findByRole("button", { name: /Next day with data/ });
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(next);
  await waitFor(() => expect(urlOf(router)).toBe("/local/lsstcam"));
});

// AuxTel with one date, 2026-04-10: `config` sets what the camera config says
// about a Nightly Summary, and the date payload says whether that night has
// one.
function stubNightReportCamera(
  config: Partial<CameraOut>,
  hasNightReport: boolean | (() => boolean),
) {
  const has = () =>
    typeof hasNightReport === "function" ? hasNightReport() : hasNightReport;
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
        channels: [],
        metadata_columns: {},
        ...config,
      };
    } else if (/\/dates\//.test(url)) {
      body = {
        per_day: {},
        metadata: {},
        channels: {},
        extensions: {},
        has_night_report: has(),
      };
    } else if (/\/nightly-summary\//.test(url)) {
      body = { exists: has() };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

test("a night with a nightly summary gets a tab for it", async () => {
  stubNightReportCamera({ night_report_label: "Night Log" }, true);
  renderAt("/local/auxtel?date=2026-04-10");
  // Labelled as the camera's config says, and carrying the date along.
  const tab = await screen.findByRole("link", { name: /Night Log/ });
  expect(tab.getAttribute("href")).toBe(
    "/local/auxtel/nightly-summary?date=2026-04-10",
  );
});

test("a nightly summary configured by prefix alone gets the default tab label", async () => {
  // As auxtel is configured: a prefix, no label.
  stubNightReportCamera({ night_report_prefix: "auxtel_night_reports" }, true);
  renderAt("/local/auxtel?date=2026-04-10");
  // The Table's toolbar links there too; the tab is the one in the tabs row.
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("link", { name: "Nightly Summary" })
        .some((l) => l.classList.contains("tab")),
    ).toBe(true),
  );
});

test("the nightly summary page keeps its tab on a night without one", async () => {
  // A deep link to a night with no summary: the page says so, and the tab
  // still shows which view this is.
  stubNightReportCamera({ night_report_prefix: "auxtel_night_reports" }, false);
  renderAt("/local/auxtel/nightly-summary?date=2026-04-10");
  const tab = await screen.findByRole("link", { name: "Nightly Summary" });
  expect(tab.getAttribute("aria-current")).toBe("page");
});

test("the tab appears when the night's first summary lands", async () => {
  // The Table is on the camera topic and never hears `nightReport`; the
  // server sends a date's first report as a change to the date's data.
  let landed = false;
  stubNightReportCamera(
    { night_report_prefix: "auxtel_night_reports" },
    () => landed,
  );
  renderAt("/local/auxtel?date=2026-04-10");
  await screen.findByText("No data for 2026-04-10.");
  expect(screen.queryByRole("link", { name: "Nightly Summary" })).toBeNull();
  landed = true;
  act(() =>
    pushLiveMessage({
      type: "channelData",
      location: "local",
      camera: "auxtel",
      date: "2026-04-10",
    }),
  );
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("link", { name: "Nightly Summary" })
        .some((l) => l.classList.contains("tab")),
    ).toBe(true),
  );
});

const AUXTEL = {
  name: "auxtel",
  title: "AuxTel",
  channels: [],
  night_report_label: null,
  night_report_prefix: "auxtel_night_reports",
} as unknown as CameraOut;

test("a night without a nightly summary gets no tab for it", () => {
  expect(tabsForCamera(AUXTEL, false).map((t) => t.id)).toEqual(["table"]);
  expect(tabsForCamera(AUXTEL, true).map((t) => t.id)).toEqual([
    "table",
    "nightly-summary",
  ]);
});

test("a camera without a nightly summary gets no tab for it", () => {
  const comcam = {
    ...AUXTEL,
    name: "comcam",
    title: "ComCam",
    night_report_prefix: null,
  } as unknown as CameraOut;
  // Even if a night somehow had one, the config doesn't offer the view.
  expect(tabsForCamera(comcam, true).map((t) => t.id)).toEqual(["table"]);
});

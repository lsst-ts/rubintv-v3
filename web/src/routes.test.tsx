import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { createQueryClient } from "./lib/queryClient";
import { LiveProvider } from "./lib/LiveContext";
import { routes } from "./routes";

// Views fetch on mount; in jsdom those calls fail, but headings still render
// from the route, which is what we assert (the URL resolves to the view).
beforeEach(() => {
  // Path-aware stub: /locations returns an array; detail endpoints return
  // an object with empty collections. Enough for views to render headings.
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

test("channel deep link resolves to the channel view", async () => {
  renderAt("/local/lsstcam/witness_detector?seq=1&date=2026-04-10");
  // The channel view's heading includes the channel name.
  expect(await screen.findByText(/witness_detector/)).toBeDefined();
});

test("channels route renders the channel browser, grouped by cadence", async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = { ok: true };
    if (/\/cameras\/lsstcam$/.test(url)) {
      body = {
        name: "lsstcam",
        title: "LSSTCam",
        channels: [
          { name: "monitor", title: "Monitor", label: "raw", per_day: false },
          {
            name: "day_movie",
            title: "Day Movie",
            label: "stitched",
            per_day: true,
          },
        ],
      };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;

  renderAt("/local/lsstcam/channels");
  // Cadence groups, one card per channel, each linking to its live viewer.
  expect(await screen.findByText("Image channels")).toBeDefined();
  expect(screen.getByText("Per night")).toBeDefined();
  const monitor = screen.getByRole("link", { name: /Monitor/ });
  expect(monitor.getAttribute("href")).toBe("/local/lsstcam/monitor/current");
  expect(screen.getByRole("link", { name: /Day Movie/ })).toBeDefined();
});

test("channel /current route follows the newest exposure", async () => {
  // Calendar's newest date is 2026-04-10; the monitor channel's highest seq in
  // that date's payload is 252, so the live view should render that image.
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = { ok: true };
    if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: ["2026-04-10", "2026-04-09"] };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = {
        name: "auxtel",
        title: "AuxTel",
        channels: [],
        image_viewer_link:
          "http://ccs.lsst.org/view?image=AT_O_{dayObs}_{seqNum:06}&raft=R00",
      };
    } else if (/\/dates\//.test(url)) {
      body = {
        per_day: {},
        metadata: {},
        channels: { monitor: [250, 251, 252] },
        extensions: { monitor: { default: "png", exceptions: {} } },
      };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;

  renderAt("/local/auxtel/monitor/current");
  const img = await screen.findByRole("img", { name: /monitor 252/ });
  expect(img.getAttribute("src")).toContain(
    "/channels/monitor/2026-04-10/000252/image.png",
  );
  // Live badge present; no "jump to current" link in live mode.
  expect(screen.getByText("● LIVE")).toBeDefined();
  // Back arrow steps to the older seq (251); there is no newer arrow at the
  // latest exposure, so it never links to the image on screen.
  const back = screen.getByRole("link", { name: /← 251/ });
  expect(back.getAttribute("href")).toContain("seq=251");
  expect(screen.queryByRole("link", { name: /→/ })).toBeNull();
  // The image viewer link no longer lives in the channel sidebar — it moved to
  // the camera table as a per-row link (covered separately below).
  expect(
    screen.queryByRole("link", { name: "Open in image viewer" }),
  ).toBeNull();
});

test("camera table shows per-row viewer, quicklook, and copy-row controls", async () => {
  // A camera configured with all three per-row link templates, one date with a
  // single seq carrying a "controller" metadata value (which feeds the
  // {controller:default=O} placeholder).
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = { ok: true };
    if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: ["2026-04-10"] };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = {
        name: "auxtel",
        title: "AuxTel",
        channels: [{ name: "monitor", per_day: false }],
        metadata_columns: {},
        image_viewer_link:
          "http://ccs.lsst.org/view?image=AT_{controller:default=O}_{dayObs}_{seqNum:06}",
        quicklook_viewer_link:
          "https://usdf-rsp.slac.stanford.edu/q/{dayObs}{seqNum:05}",
        copy_row_template:
          'dataId = {"day_obs": {dayObs}, "seq_num": {seqNum:06}}',
      };
    } else if (/\/metadata\//.test(url)) {
      body = { "252": { controller: "C" } };
    } else if (/\/dates\//.test(url)) {
      body = {
        per_day: {},
        metadata: {},
        channels: { monitor: [252] },
        extensions: { monitor: { default: "png", exceptions: {} } },
      };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;

  renderAt("/local/auxtel?date=2026-04-10");

  // Viewer link fills the row's controller ("C"), the 8-digit date, and the
  // zero-padded seq.
  const viewer = await screen.findByRole("link", { name: "Viewer" });
  expect(viewer.getAttribute("href")).toBe(
    "http://ccs.lsst.org/view?image=AT_C_20260410_000252",
  );
  // Quicklook fills {seqNum:05}.
  const quicklook = screen.getByRole("link", { name: "Quicklook" });
  expect(quicklook.getAttribute("href")).toBe(
    "https://usdf-rsp.slac.stanford.edu/q/2026041000252",
  );
  // Copy-row button is present (its filled text rides on the title attribute).
  const copy = screen.getByRole("button", { name: "Copy row" });
  expect(copy.getAttribute("title")).toBe(
    'dataId = {"day_obs": 20260410, "seq_num": 000252}',
  );

  // Download-metadata button is enabled once metadata has loaded; clicking it
  // builds a blob URL and triggers an anchor download.
  const createObjectURL = vi.fn(() => "blob:meta");
  const revokeObjectURL = vi.fn();
  globalThis.URL.createObjectURL = createObjectURL;
  globalThis.URL.revokeObjectURL = revokeObjectURL;
  const clicks: string[] = [];
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    clicks.push((this as HTMLAnchorElement).download);
  };
  try {
    const download = screen.getByRole("button", { name: "Download metadata" });
    expect((download as HTMLButtonElement).disabled).toBe(false);
    download.click();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clicks).toEqual(["auxtel_2026-04-10_metadata.json"]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:meta");
  } finally {
    HTMLAnchorElement.prototype.click = realClick;
  }
});

test("mosaic suffix route wins over the channel catch-all", async () => {
  renderAt("/local/lsstcam/mosaic");
  expect(await screen.findByText("Mosaic / Movies")).toBeDefined();
});

test("column picker defaults to configured columns and reset restores them", async () => {
  // One configured column (Exposure) + one data-only column (sky_mean) seen in
  // the metadata. Default shows only the configured one; the picker head's
  // count, search, and reset reflect that.
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = { ok: true };
    if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: ["2026-04-10"] };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = {
        name: "auxtel",
        title: "AuxTel",
        channels: [],
        metadata_columns: { Exposure: "Exposure time" },
      };
    } else if (/\/metadata\//.test(url)) {
      body = { "1": { Exposure: "30", sky_mean: "9000" } };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels: {}, extensions: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;

  renderAt("/local/auxtel?date=2026-04-10");

  // Default: 1 of 2 shown (only the configured Exposure column).
  const toggle = await screen.findByRole("button", { name: /Columns 1\/2/ });
  fireEvent.click(toggle);
  expect(screen.getByText("of 2 shown")).toBeDefined();

  // The search box filters the picker rows: "sky" matches the data-only column.
  const search = screen.getByLabelText("Search columns");
  fireEvent.change(search, { target: { value: "sky" } });
  expect(screen.getByText("sky_mean")).toBeDefined();
  // A non-matching query empties the list.
  fireEvent.change(search, { target: { value: "zzz" } });
  expect(screen.getByText(/no columns match/)).toBeDefined();
  fireEvent.change(search, { target: { value: "" } });

  // "all" shows both; "reset" returns to the configured default (1/2).
  fireEvent.click(screen.getByText("none"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Columns 0\/2/ })).toBeDefined(),
  );
  fireEvent.click(screen.getByText("all"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Columns 2\/2/ })).toBeDefined(),
  );
  fireEvent.click(screen.getByText("reset"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Columns 1\/2/ })).toBeDefined(),
  );
});

test("date picker opens a year heatmap; selecting a data day sets ?date", async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = { ok: true };
    if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = {
        dates: ["2026-04-10", "2025-08-30"],
        counts: { "2026-04-10": 1335, "2025-08-30": 171 },
        max_seq: { "2026-04-10": 1340, "2025-08-30": 174 },
      };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = { name: "auxtel", title: "AuxTel", channels: [], metadata_columns: {} };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels: {}, extensions: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;

  const router = createMemoryRouter(routes, {
    initialEntries: ["/local/auxtel?date=2026-04-10"],
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>,
  );

  // Open the picker (defaults to the Months view) and switch to the heatmap.
  const trigger = await screen.findByRole("button", { name: /2026-04-10/ });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: /Choose date/ });
  fireEvent.click(within(dialog).getByRole("tab", { name: "Heatmap" }));
  // A year block per year with data is shown.
  expect(within(dialog).getByText("2026")).toBeDefined();
  expect(within(dialog).getByText("2025")).toBeDefined();

  // Clicking a heatmap day jumps to the month view on that date (overview →
  // detail); it doesn't commit yet.
  const heatDay = within(dialog).getByTitle(/2025-08-30 · 171 exposures/);
  fireEvent.click(heatDay);
  expect(
    (within(dialog).getByRole("tab", { name: "Months" }) as HTMLElement).getAttribute(
      "aria-selected",
    ),
  ).toBe("true");
  expect(within(dialog).getByText("August")).toBeDefined();
  expect(router.state.location.search).toContain("date=2026-04-10"); // not yet committed

  // The month cell carries the day's max seq num (per-seq camera). Confirm the
  // pick by clicking the in-month "30" cell.
  const day30 = within(dialog).getByTitle("2025-08-30 · max seq 174");
  fireEvent.click(day30);
  await waitFor(() =>
    expect(router.state.location.search).toContain("date=2025-08-30"),
  );
});

test("All Sky date picker shows the has-data dot, not a max seq num", async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = { ok: true };
    if (/\/cameras\/allsky\/calendar$/.test(url)) {
      body = {
        dates: ["2026-04-10"],
        counts: { "2026-04-10": 25 },
        max_seq: { "2026-04-10": 25 },
      };
    } else if (/\/cameras\/allsky$/.test(url)) {
      body = {
        name: "allsky",
        title: "All Sky",
        live_view: true,
        channels: [],
        mosaic_view_meta: [],
      };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels: {}, extensions: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;

  localStorage.removeItem("rubintv.datepicker.mode"); // start on Months
  renderAt("/local/allsky?date=2026-04-10");
  const trigger = await screen.findByRole("button", { name: /2026-04-10/ });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: /Choose date/ });
  // Month view — All Sky shows only the has-data dot, no max seq.
  expect(within(dialog).getByTitle("2026-04-10 · has data")).toBeDefined();
  expect(within(dialog).queryByTitle(/max seq/)).toBeNull();
});

test("column picker dismisses on Escape and on an outside click", async () => {
  // A camera + date whose metadata carries a column, so the picker has content.
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = { ok: true };
    if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: ["2026-04-10"] };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = { name: "auxtel", title: "AuxTel", channels: [], metadata_columns: {} };
    } else if (/\/metadata\//.test(url)) {
      body = { "1": { exposure_time: "30" } };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels: {}, extensions: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;

  renderAt("/local/auxtel?date=2026-04-10");
  const toggle = await screen.findByRole("button", { name: /Columns/ });

  // Escape closes it.
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() =>
    expect(toggle.getAttribute("aria-expanded")).toBe("false"),
  );

  // An outside pointerdown closes it.
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.pointerDown(document.body);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-expanded")).toBe("false"),
  );
});

test("night report renders folder tabs (text items + plot groups)", async () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = { ok: true };
    if (/\/night-report\//.test(url)) {
      body = {
        date: "2026-04-10",
        exists: true,
        text: [
          { type: "keyvalues", title: "Summary", content: { dome: "open" } },
        ],
        plots: [
          { key: "k1", group: "Seeing", filename: "seeing_vs_time.png" },
          { key: "k2", group: "Seeing", filename: "psf_fwhm.png" },
          { key: "k3", group: "Photometry", filename: "zeropoint.png" },
        ],
      };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;

  renderAt("/local/lsstcam/night-report?date=2026-04-10");
  // One tab per text item, one per plot group.
  expect(await screen.findByRole("tab", { name: /Summary/ })).toBeDefined();
  expect(screen.getByRole("tab", { name: /Seeing/ })).toBeDefined();
  expect(screen.getByRole("tab", { name: /Photometry/ })).toBeDefined();
  // The first (Summary) tab's key/value content shows by default.
  expect(screen.getByText("dome")).toBeDefined();
});

test("/status resolves to the scan-status view, not a location", async () => {
  renderAt("/status");
  expect(await screen.findByText("Scan status")).toBeDefined();
});

test("/detectors resolves to the cluster-status view, not a location", async () => {
  renderAt("/detectors");
  expect(
    await screen.findByRole("heading", { name: "Cluster Status" }),
  ).toBeDefined();
});

test("/admin resolves to the admin view, not a location", async () => {
  renderAt("/admin");
  expect(await screen.findByRole("heading", { name: "Admin" })).toBeDefined();
});

// Shared stub for the live_view (All Sky) tests: a camera reporting live_view
// with a stills (image) and movies (video) channel, a two-date calendar, and a
// date payload with integer seqs. The newest date (2026-04-10) is "current".
function stubAllSky() {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = { ok: true };
    if (/\/cameras\/allsky\/calendar$/.test(url)) {
      body = { dates: ["2026-04-10", "2026-04-09"] };
    } else if (/\/cameras\/allsky$/.test(url)) {
      body = {
        name: "allsky",
        title: "All Sky",
        channels: [
          { name: "stills", title: "Current Image", per_day: false },
          { name: "movies", title: "Current Movie", per_day: false },
        ],
        live_view: true,
        mosaic_view_meta: [
          { channel: "stills", media_type: "image", meta_columns: [] },
          { channel: "movies", media_type: "video", meta_columns: [] },
        ],
      };
    } else if (/\/dates\//.test(url)) {
      body = {
        per_day: {},
        metadata: {},
        channels: { stills: [1, 2, 3], movies: [5, 8] },
        extensions: {
          stills: { default: "jpg", exceptions: {} },
          movies: { default: "mp4", exceptions: {} },
        },
      };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

test("a live_view camera renders the live-view panel, not the table", async () => {
  // CameraTable should delegate to the AllSky panel for a live_view camera.
  stubAllSky();
  const { container } = renderAt("/local/allsky?date=2026-04-10");
  expect(await screen.findByText("All Sky")).toBeDefined();
  expect(container.querySelector(".live-view-media")).not.toBeNull();
  expect(container.querySelector("table.data-table")).toBeNull();
});

test("current All Sky date shows latest still and movie at their max seq", async () => {
  stubAllSky();
  // Newest date in the calendar -> live mode: still (seq 3) + movie (seq 8).
  renderAt("/local/allsky?date=2026-04-10");
  const still = await screen.findByRole("img", { name: /Current Image 3/ });
  expect(still.getAttribute("src")).toContain(
    "/channels/stills/2026-04-10/000003/image.jpg",
  );
  const movie = document.querySelector("video");
  expect(movie?.getAttribute("src")).toContain(
    "/channels/movies/2026-04-10/000008/image.mp4",
  );
});

test("historical All Sky date shows the final movie only, no stills", async () => {
  stubAllSky();
  // An older date -> historical mode: movie at the "final" sentinel, no still.
  renderAt("/local/allsky?date=2026-04-09");
  await screen.findByText("Current Movie");
  const movie = document.querySelector("video");
  expect(movie?.getAttribute("src")).toContain(
    "/channels/movies/2026-04-09/final/movie.mp4",
  );
  // No stills tile for a past day.
  expect(screen.queryByText("Current Image")).toBeNull();
  expect(document.querySelector("img")).toBeNull();
});

test("home renders", async () => {
  renderAt("/");
  // "RubinTV" also appears in the breadcrumb link; assert on the heading.
  expect(
    await screen.findByRole("heading", { name: "RubinTV" }),
  ).toBeDefined();
});

test("home sets the browser tab title to the app name", async () => {
  renderAt("/");
  await waitFor(() => expect(document.title).toBe("RubinTV"));
});

test("static pages set a reflective tab title", async () => {
  renderAt("/status");
  await waitFor(() => expect(document.title).toBe("Scan status · RubinTV"));

  renderAt("/admin");
  await waitFor(() => expect(document.title).toBe("Admin · RubinTV"));
});

test("the camera table sets a tab title from the camera and date", async () => {
  // Reuse the All Sky stub's sibling: a plain camera with a title and a date in
  // the URL. The default stub returns empty collections, so the camera config
  // (and thus its title) isn't available; assert the URL-param fallback + date.
  renderAt("/local/lsstcam?date=2026-04-10");
  await waitFor(() =>
    expect(document.title).toBe("lsstcam · 2026-04-10 · RubinTV"),
  );
});

test("camera table shows an empty-state notice, not the table, when a date has no data", async () => {
  // The default stub resolves the date payload with empty channels/metadata,
  // so there are no rows: show the tidy notice instead of a bare angled header.
  const { container } = renderAt("/local/lsstcam?date=2026-04-10");
  expect(await screen.findByText(/No data for 2026-04-10/)).toBeDefined();
  expect(container.querySelector("table.data-table")).toBeNull();
});

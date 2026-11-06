import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
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

// AuxTel with one date, 2026-04-10: `config` sets what the camera config says
// about a Nightly Summary, and the date payload says whether that night has
// one.
function stubNightReportCamera(
  config: Partial<CameraOut>,
  hasNightReport: boolean,
) {
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
        has_night_report: hasNightReport,
      };
    } else if (/\/nightly-summary\//.test(url)) {
      body = { exists: hasNightReport };
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

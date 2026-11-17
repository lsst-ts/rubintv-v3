import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { Status } from "./Status";
import type { CacheUsageResponse, StatusResponse } from "../lib/types";

const NO_CACHE_USAGE: CacheUsageResponse = {
  enabled: false,
  dir: null,
  entries: [],
  volume_total_bytes: null,
  volume_free_bytes: null,
};

function renderWith(
  cameras: StatusResponse["cameras"],
  over: Partial<StatusResponse> = {},
  cacheUsage: CacheUsageResponse = NO_CACHE_USAGE,
) {
  const payload: StatusResponse = {
    ready: true,
    cache_enabled: true,
    warm_start: false,
    historical_loading: cameras.some((c) => !c.full_complete),
    s3_healthy: true,
    s3_slow: false,
    s3_last_cycle_seconds: 0.8,
    cameras,
    ...over,
  };
  globalThis.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(url.endsWith("/health/cache") ? cacheUsage : payload),
    })) as unknown as typeof fetch;
  return render(
    <QueryClientProvider client={createQueryClient()}>
      {/* The page now carries the WebSocket-status pill, which reads the
          LiveProvider context (backed by the StubWebSocket in test-setup). */}
      <LiveProvider>
        <MemoryRouter>
          <Status />
        </MemoryRouter>
      </LiveProvider>
    </QueryClientProvider>,
  );
}

const cam = (over: Partial<StatusResponse["cameras"][number]>) => ({
  location: "loc",
  camera: "cam",
  location_title: "Loc",
  camera_title: "Cam",
  recent_ready: false,
  full_complete: false,
  image_count: 0,
  ...over,
});

// Each camera row's stage pill and image count, read row by row (the key
// shows the same pills, so a bare text query would match twice).
async function cameraRows() {
  return (await screen.findAllByRole("listitem")).map((li) => ({
    stage: within(li).getByText(/^(Loading…|Recent|Complete)$/)
      .textContent,
    images: within(li).getByTitle("Images found so far").textContent,
  }));
}

test("shows each camera's stage label", async () => {
  renderWith([
    cam({ camera: "a", recent_ready: false, full_complete: false }),
    cam({ camera: "b", recent_ready: true, full_complete: false }),
    cam({ camera: "c", recent_ready: true, full_complete: true }),
  ]);
  expect((await cameraRows()).map((r) => r.stage)).toEqual([
    "Loading…",
    "Recent",
    "Complete",
  ]);
});

test("shows how many images each camera's scan has found, as a bare count", async () => {
  renderWith([
    cam({ camera: "a", image_count: 12345 }),
    cam({ camera: "b", image_count: 1 }),
    cam({ camera: "c", image_count: 0 }),
  ]);
  expect((await cameraRows()).map((r) => r.images)).toEqual([
    (12345).toLocaleString(),
    "1",
    "0",
  ]);
});

test("explains the stage pills in a key", async () => {
  renderWith([cam({})]);
  expect(await screen.findByText("scanning the most recent days")).toBeDefined();
  expect(
    screen.getByText("recent days viewable; older history still loading"),
  ).toBeDefined();
  expect(screen.getByText("all history loaded")).toBeDefined();
});

test("labels the cards and cameras with their display titles", async () => {
  renderWith([
    cam({
      location: "summit-usdf",
      location_title: "Summit",
      camera: "lsstcam_aos",
      camera_title: "LSSTCamAOS",
    }),
  ]);
  expect(await screen.findByRole("heading", { name: "Summit" })).toBeDefined();
  const link = screen.getByRole("link", { name: "LSSTCamAOS" });
  expect(link.getAttribute("href")).toBe("/summit-usdf/lsstcam_aos");
});

test("each card counts its cameras whose full sweep is complete", async () => {
  renderWith([
    cam({ camera: "a", full_complete: true, recent_ready: true }),
    cam({ camera: "b", full_complete: false, recent_ready: true }),
  ]);
  expect(await screen.findByText("1/2 complete")).toBeDefined();
});

test("a fully loaded location reads as all complete", async () => {
  renderWith([cam({ full_complete: true, recent_ready: true })]);
  expect(await screen.findByText("1/1 complete")).toBeDefined();
});

// The cache mode is a pill among the indicators, described by its tooltip.
test("flags a disabled disk cache as an alert pill", async () => {
  renderWith([cam({})], { cache_enabled: false });
  const pill = await screen.findByRole("alert");
  expect(pill.textContent).toBe("Disk cache disabled");
  expect(pill.getAttribute("title")).toMatch(/Set cache_dir/);
});

test("shows a warm-start pill when the cache populated the calendar", async () => {
  renderWith([cam({ recent_ready: true })], {
    cache_enabled: true,
    warm_start: true,
  });
  const pill = await screen.findByText("Warm start");
  expect(pill.getAttribute("title")).toMatch(/restored from the disk cache/);
});

test("lists where the disk cache lives, its sizes and what uses each part", async () => {
  renderWith([cam({})], { cache_enabled: true, warm_start: true }, {
    enabled: true,
    dir: "/scratch",
    entries: [
      { path: "/scratch/v3", use: "index", files: 5524, bytes: 45 * 2 ** 20 },
      { path: "/scratch/guide", use: "guide", files: 2, bytes: 1.1 * 2 ** 20 },
      { path: "/scratch/v1", use: "unused", files: 5007, bytes: 42 * 2 ** 20 },
    ],
    volume_total_bytes: 2 ** 30,
    volume_free_bytes: 768 * 2 ** 20,
  });
  expect(await screen.findByText(/: 88\.1 MiB$/)).toBeDefined();
  // The volume is shared, so it gets its own line whose figures add up.
  expect(
    screen.getByText(
      "Volume (shared with other files): 256.0 MiB used, 768.0 MiB free, 1.0 GiB total",
    ),
  ).toBeDefined();
  expect(screen.getByText("/scratch")).toBeDefined();
  const rows = screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent));
  expect(rows).toEqual([
    ["/scratch/v3", "45.0 MiB", (5524).toLocaleString(), "scan index (warm starts)"],
    ["/scratch/guide", "1.1 MiB", "2", "observing-block guide"],
    ["/scratch/v1", "42.0 MiB", (5007).toLocaleString(), "not used by this version"],
  ]);
});

test("a cold first run shows the empty index, and no volume it can't read", async () => {
  renderWith([cam({})], { cache_enabled: true }, {
    enabled: true,
    dir: "/scratch",
    entries: [{ path: "/scratch/v3", use: "index", files: 0, bytes: 0 }],
    volume_total_bytes: null,
    volume_free_bytes: null,
  });
  // The path renders as a receding dir prefix plus the entry's name.
  expect((await screen.findByText("v3")).textContent).toBe("/scratch/v3");
  expect(screen.getByText("0 B")).toBeDefined();
  expect(screen.getByText(/^Disk cache in/).textContent).toBe(
    "Disk cache in /scratch: 0 B",
  );
  expect(screen.queryByText(/^Volume/)).toBeNull();
});

test("shows a cold-start pill when no snapshot was loaded", async () => {
  renderWith([cam({})], { cache_enabled: true, warm_start: false });
  const pill = await screen.findByText("Cold start");
  expect(pill.getAttribute("title")).toMatch(/No cached snapshot/);
});

test("shows the WebSocket-connection pill (moved here from the topbar)", async () => {
  renderWith([cam({})]);
  expect(
    await screen.findByText(/WebSocket (connected|connecting|disconnected)/),
  ).toBeDefined();
});

test("the S3 section shows an explicit healthy pill", async () => {
  renderWith([cam({})], { s3_healthy: true });
  expect(await screen.findByText(/S3 connected/)).toBeDefined();
});

test("surfaces the S3 pill here when the bucket is unreachable", async () => {
  renderWith([cam({})], { s3_healthy: false });
  expect(await screen.findByText(/S3 unreachable/)).toBeDefined();
});

test("shows the last S3 poll latency while healthy", async () => {
  renderWith([cam({})], { s3_healthy: true, s3_last_cycle_seconds: 1.2 });
  expect(await screen.findByText(/Last poll:/)).toBeDefined();
  expect(screen.getByText(/1\.2s/)).toBeDefined();
});

test("hides the latency line before the first cycle completes", async () => {
  renderWith([cam({})], { s3_healthy: true, s3_last_cycle_seconds: 0 });
  await screen.findByText(/Scan status/);
  expect(screen.queryByText(/Last poll:/)).toBeNull();
});

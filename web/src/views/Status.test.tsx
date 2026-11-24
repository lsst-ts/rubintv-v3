import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { Status } from "./Status";
import type { CacheUsageResponse, StatusResponse } from "../lib/types";

const NO_CACHE_USAGE: CacheUsageResponse = {
  enabled: false,
  problems: [],
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
    poll_stalled: false,
    last_poll_age_seconds: 2,
    redis: {
      configured: false,
      connected: false,
      changed_age_seconds: null,
      read_age_seconds: null,
    },
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
    problems: [],
    dir: "/scratch",
    entries: [
      { path: "/scratch/v3", use: "index", files: 5524, bytes: 45 * 2 ** 20, unreadable: false },
      { path: "/scratch/guide", use: "guide", files: 2, bytes: 1.1 * 2 ** 20, unreadable: false },
      { path: "/scratch/v1", use: "unused", files: 5007, bytes: 42 * 2 ** 20, unreadable: false },
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
    problems: [],
    dir: "/scratch",
    entries: [{ path: "/scratch/v3", use: "index", files: 0, bytes: 0, unreadable: false }],
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

const INDEX_ENTRY = {
  path: "/scratch/v3",
  use: "index",
  files: 5524,
  bytes: 45 * 2 ** 20,
  unreadable: false,
} as const;

test("a cache that isn't taking writes says so, top and bottom", async () => {
  // The pages look fine throughout (the cache is only read at startup), so
  // this is the one place a cache that has stopped being kept shows.
  renderWith([cam({})], { cache_enabled: true, warm_start: true }, {
    enabled: true,
    problems: [
      { kind: "not_writable", detail: "The last write failed: No space left on device" },
    ],
    dir: "/scratch",
    entries: [INDEX_ENTRY],
    volume_total_bytes: null,
    volume_free_bytes: null,
  });
  const pill = await screen.findByRole("alert");
  expect(pill.textContent).toBe("Cache not writable");
  expect(pill.closest('[aria-label="Start-up"]')).not.toBeNull();
  expect(pill.getAttribute("title")).toMatch(
    /aren't being saved.*older index\. The last write failed: No space left on device\.$/,
  );
  // In the notice: its name, what it costs and the cause, a line each.
  const item = within(screen.getByRole("note")).getByRole("listitem");
  expect([...item.children].map((c) => c.textContent)).toEqual([
    "Cache not writable",
    "New scan results aren't being saved, so a restart now would start from an older index.",
    "The last write failed: No space left on device",
  ]);
  // What is there can still be measured.
  expect(screen.getByText(/^Disk cache in/).textContent).toBe(
    "Disk cache in /scratch: 45.0 MiB",
  );
});

test("an index the server can't list reads as unknown, not as empty", async () => {
  renderWith([cam({})], { cache_enabled: true }, {
    enabled: true,
    problems: [
      { kind: "unreadable", detail: "Permission denied: v3" },
      { kind: "not_writable", detail: "No write permission on v3" },
    ],
    dir: "/scratch",
    entries: [{ ...INDEX_ENTRY, files: 0, bytes: 0, unreadable: true }],
    volume_total_bytes: null,
    volume_free_bytes: null,
  });
  const pills = await screen.findAllByRole("alert");
  expect(pills.map((p) => p.textContent)).toEqual([
    "Cache unreadable",
    "Cache not writable",
  ]);
  expect(screen.getByText(/^Disk cache in/).textContent).toBe(
    "Disk cache in /scratch: size unknown",
  );
  const cells = [...screen.getAllByRole("row")[1].querySelectorAll("td")];
  expect(cells.map((td) => td.textContent)).toEqual([
    "/scratch/v3",
    "unknown",
    "unknown",
    "scan index (warm starts)",
  ]);
  expect(screen.queryByText("0 B")).toBeNull();
  expect(within(screen.getByRole("note")).getAllByRole("listitem")).toHaveLength(2);
});

test("a volume that has stopped answering shows no sizes at all", async () => {
  renderWith([cam({})], { cache_enabled: true }, {
    enabled: true,
    problems: [
      { kind: "not_responding", detail: "A write has not returned for 42 s" },
    ],
    dir: "/scratch",
    entries: [],
    volume_total_bytes: null,
    volume_free_bytes: null,
  });
  expect((await screen.findByRole("alert")).textContent).toBe("Cache not responding");
  expect(screen.getByText(/^Disk cache in/).textContent).toBe(
    "Disk cache in /scratch: size unknown",
  );
  expect(screen.getByText("A write has not returned for 42 s")).toBeDefined();
  expect(screen.queryByRole("table")).toBeNull();
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

test("shows when the last S3 poll succeeded and how long it took", async () => {
  renderWith([cam({})], { s3_healthy: true, s3_last_cycle_seconds: 1.2 });
  const line = await screen.findByText(/Last poll:/);
  expect(line.textContent).toMatch(/Last poll: \d\d:\d\d:\d\d UTC, took 1\.2s/);
  expect(line.querySelector(".s3-latency--slow")).toBeNull();
});

test("a slow last poll has its duration in amber", async () => {
  renderWith([cam({})], { s3_slow: true, s3_last_cycle_seconds: 6.34 });
  const line = await screen.findByText(/Last poll:/);
  expect(line.querySelector(".s3-latency--slow")?.textContent).toBe("6.3s");
});

test("a last poll that is no longer recent is amber, with its age", async () => {
  // Unreachable, so the last cycle to succeed says nothing of the link now:
  // the time stays, the duration goes.
  renderWith([cam({})], { s3_healthy: false, last_poll_age_seconds: 300 });
  const line = await screen.findByText(/Last poll:/);
  expect(line.textContent).toMatch(/UTC \(5 min ago\)$/);
  expect(line.querySelector(".s3-latency--slow")?.textContent).toMatch(/5 min ago/);
});

test("hides the last-poll line before the first cycle completes", async () => {
  renderWith([cam({})], {
    s3_healthy: true,
    s3_last_cycle_seconds: 0,
    last_poll_age_seconds: null,
  });
  await screen.findByText(/Scan status/);
  expect(screen.queryByText(/Last poll:/)).toBeNull();
});

describe("the Redis link", () => {
  // The third link the page reports on: whether the server is reading Redis,
  // which the Cluster Status and Admin pages show the last word of.
  const redis = (over: Partial<StatusResponse["redis"]>) => ({
    redis: {
      configured: true,
      connected: true,
      changed_age_seconds: 3600,
      read_age_seconds: 2,
      ...over,
    },
  });

  test("a deployment without Redis says so, quietly", async () => {
    renderWith([cam({})]);
    const pill = await screen.findByText("Redis not configured");
    expect(pill.getAttribute("role")).toBe("status");
    expect(pill.className).toBe("conn conn-closed");
    expect(screen.queryByText(/Redis last read/)).toBeNull();
  });

  test("a Redis that is answering shows green, with when it last did", async () => {
    renderWith([cam({})], redis({}));
    const pill = await screen.findByText("Redis connected");
    expect(pill.className).toBe("conn conn-open");
    const line = screen.getByText(/Redis last read:/);
    expect(line.textContent).toMatch(/^Redis last read: \d\d:\d\d:\d\d UTC$/);
    expect(line.querySelector(".s3-latency--slow")).toBeNull();
  });

  test("a Redis that has stopped answering is an alert, dated", async () => {
    renderWith(
      [cam({})],
      redis({ connected: false, changed_age_seconds: 290, read_age_seconds: 300 }),
    );
    const pill = await screen.findByRole("alert");
    expect(pill.textContent).toBe("Redis unreachable");
    expect(pill.getAttribute("title")).toMatch(
      /no answer from Redis since \d\d:\d\d:\d\d UTC \(5 min\)\. .* keeps trying/,
    );
    const line = screen.getByText(/Redis last read:/);
    expect(line.querySelector(".s3-latency--slow")?.textContent).toMatch(
      /UTC \(5 min ago\)$/,
    );
  });

  test("one that has never answered has no last read to show", async () => {
    renderWith(
      [cam({})],
      redis({ connected: false, changed_age_seconds: 40, read_age_seconds: null }),
    );
    const pill = await screen.findByRole("alert");
    expect(pill.getAttribute("title")).toMatch(
      /no answer from Redis since the server started \(40 s\)/,
    );
    expect(screen.queryByText(/Redis last read/)).toBeNull();
  });

  test("a last read that has stopped moving is amber even while connected", async () => {
    // The server says connected but its last answer from Redis is old: the
    // age is what the page goes by.
    renderWith([cam({})], redis({ read_age_seconds: 120 }));
    const line = await screen.findByText(/Redis last read:/);
    expect(line.querySelector(".s3-latency--slow")?.textContent).toMatch(
      /2 min ago/,
    );
  });

  test("a server that doesn't say (an older one) shows nothing of Redis", async () => {
    renderWith([cam({})], { redis: undefined });
    await screen.findByText(/S3 connected/);
    expect(screen.queryByText(/Redis/)).toBeNull();
  });
});

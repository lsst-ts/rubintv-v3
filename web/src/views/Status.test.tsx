import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { Status } from "./Status";
import type { StatusResponse } from "../lib/types";

function renderWith(
  cameras: StatusResponse["cameras"],
  over: Partial<StatusResponse> = {},
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
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(payload),
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
  recent_ready: false,
  full_complete: false,
  ...over,
});

test("shows each camera's stage label", async () => {
  renderWith([
    cam({ camera: "a", recent_ready: false, full_complete: false }),
    cam({ camera: "b", recent_ready: true, full_complete: false }),
    cam({ camera: "c", recent_ready: true, full_complete: true }),
  ]);
  expect(await screen.findByText("Loading…")).toBeDefined();
  expect(screen.getByText("Recent ready")).toBeDefined();
  expect(screen.getByText("Complete")).toBeDefined();
});

test("summarises how many cameras remain", async () => {
  renderWith([
    cam({ camera: "a", full_complete: true, recent_ready: true }),
    cam({ camera: "b", full_complete: false, recent_ready: true }),
  ]);
  expect(await screen.findByText(/1 camera still loading/)).toBeDefined();
});

test("reports all-done when every camera is complete", async () => {
  renderWith([cam({ full_complete: true, recent_ready: true })]);
  expect(await screen.findByText("All cameras fully loaded.")).toBeDefined();
});

test("warns when the disk cache is disabled", async () => {
  renderWith([cam({})], { cache_enabled: false });
  expect(await screen.findByText(/Disk cache disabled/)).toBeDefined();
});

test("notes a warm start when the cache populated the calendar", async () => {
  renderWith([cam({ recent_ready: true })], {
    cache_enabled: true,
    warm_start: true,
  });
  expect(await screen.findByText(/Warm start:/)).toBeDefined();
});

test("notes a cold start when no snapshot was loaded", async () => {
  renderWith([cam({})], { cache_enabled: true, warm_start: false });
  expect(await screen.findByText(/Cold start:/)).toBeDefined();
});

test("shows the WebSocket-connection pill (moved here from the topbar)", async () => {
  renderWith([cam({})]);
  expect(await screen.findByText(/WebSocket/)).toBeDefined();
});

test("surfaces the S3 pill here when the bucket is unreachable", async () => {
  renderWith([cam({})], { s3_healthy: false });
  expect(await screen.findByText(/S3 unreachable/)).toBeDefined();
});

test("shows the last S3 poll latency while healthy", async () => {
  renderWith([cam({})], { s3_healthy: true, s3_last_cycle_seconds: 1.2 });
  expect(await screen.findByText(/Last S3 poll cycle/)).toBeDefined();
  expect(screen.getByText(/1\.2s/)).toBeDefined();
});

test("hides the latency line before the first cycle completes", async () => {
  renderWith([cam({})], { s3_healthy: true, s3_last_cycle_seconds: 0 });
  await screen.findByText(/Scan status/);
  expect(screen.queryByText(/Last S3 poll cycle/)).toBeNull();
});

import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
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
      <MemoryRouter>
        <Status />
      </MemoryRouter>
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

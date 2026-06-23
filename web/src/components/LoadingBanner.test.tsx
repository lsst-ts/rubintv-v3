import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../lib/queryClient";
import { LoadingBanner } from "./LoadingBanner";
import type { StatusResponse } from "../lib/types";

function renderWith(
  status: Partial<StatusResponse>,
  props: { location?: string; camera?: string } = {},
) {
  const payload: StatusResponse = {
    ready: true,
    cache_enabled: true,
    warm_start: false,
    historical_loading: false,
    s3_healthy: true,
    s3_slow: false,
    cameras: [],
    ...status,
  };
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(payload),
    })) as unknown as typeof fetch;
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LoadingBanner {...props} />
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

test("shows the site-wide banner while history is loading (no camera)", async () => {
  renderWith({ historical_loading: true });
  expect(await screen.findByText(/Loading historical data/)).toBeDefined();
});

test("renders nothing once history has loaded (no camera)", async () => {
  renderWith({ historical_loading: false });
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByText(/Loading historical data/)).toBeNull();
});

test("scopes to the current camera: full banner before recent is ready", async () => {
  renderWith(
    { historical_loading: true, cameras: [cam({})] },
    { location: "loc", camera: "cam" },
  );
  expect(await screen.findByText(/older dates may be incomplete/)).toBeDefined();
});

test("softens wording once the recent window is ready", async () => {
  renderWith(
    { historical_loading: true, cameras: [cam({ recent_ready: true })] },
    { location: "loc", camera: "cam" },
  );
  expect(await screen.findByText(/Recent dates are ready/)).toBeDefined();
});

test("on a warm start, calls the scan a refresh rather than a cold load", async () => {
  renderWith(
    { historical_loading: true, warm_start: true, cameras: [cam({})] },
    { location: "loc", camera: "cam" },
  );
  expect(await screen.findByText(/Refreshing historical data/)).toBeDefined();
  expect(screen.queryByText(/older dates may be incomplete/)).toBeNull();
});

test("warm start refresh wording also applies site-wide (no camera)", async () => {
  renderWith({ historical_loading: true, warm_start: true });
  expect(await screen.findByText(/Refreshing historical data/)).toBeDefined();
});

test("clears once the current camera's full sweep completes", async () => {
  renderWith(
    {
      // Other cameras may still be loading site-wide…
      historical_loading: true,
      cameras: [cam({ recent_ready: true, full_complete: true })],
    },
    { location: "loc", camera: "cam" },
  );
  // …but the camera in view is done, so no banner for it.
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByText(/historical data|Recent dates/)).toBeNull();
});

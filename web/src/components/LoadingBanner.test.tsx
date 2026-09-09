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
    s3_last_cycle_seconds: 0.8,
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

// The visible pill carries a short label; the fuller sentence lives in the
// title tooltip on the same status element. Assert on the tooltip so the
// wording-level intent stays covered.
const pillTitle = async () =>
  (await screen.findByRole("status")).getAttribute("title");

test("shows the site-wide pill while history is loading (no camera)", async () => {
  renderWith({ historical_loading: true });
  expect(await pillTitle()).toMatch(/Loading historical data/);
});

test("renders nothing once history has loaded (no camera)", async () => {
  renderWith({ historical_loading: false });
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByRole("status")).toBeNull();
});

test("scopes to the current camera: full wording before recent is ready", async () => {
  renderWith(
    { historical_loading: true, cameras: [cam({})] },
    { location: "loc", camera: "cam" },
  );
  expect(await pillTitle()).toMatch(/older dates may be incomplete/);
});

test("softens wording once the recent window is ready", async () => {
  renderWith(
    { historical_loading: true, cameras: [cam({ recent_ready: true })] },
    { location: "loc", camera: "cam" },
  );
  expect(await pillTitle()).toMatch(/Recent dates are ready/);
});

test("on a warm start, calls the scan a refresh rather than a cold load", async () => {
  renderWith(
    { historical_loading: true, warm_start: true, cameras: [cam({})] },
    { location: "loc", camera: "cam" },
  );
  expect(await pillTitle()).toMatch(/Refreshing historical data/);
  expect(await pillTitle()).not.toMatch(/older dates may be incomplete/);
});

test("warm start refresh wording also applies site-wide (no camera)", async () => {
  renderWith({ historical_loading: true, warm_start: true });
  expect(await pillTitle()).toMatch(/Refreshing historical data/);
});

test("reflects a stalled refresh when S3 is unreachable (no camera)", async () => {
  renderWith({
    historical_loading: true,
    warm_start: true,
    s3_healthy: false,
  });
  const pill = await screen.findByRole("status");
  expect(pill.textContent).toMatch(/Refresh stalled/);
  expect(pill.getAttribute("title")).toMatch(/Can't reach S3/);
  expect(pill.className).toMatch(/scan-stalled/);
});

test("stalled wording overrides the per-camera recent/older distinction", async () => {
  renderWith(
    {
      historical_loading: true,
      s3_healthy: false,
      cameras: [cam({ recent_ready: true })],
    },
    { location: "loc", camera: "cam" },
  );
  expect(await pillTitle()).toMatch(/Can't reach S3/);
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
  // …but the camera in view is done, so no pill for it.
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByRole("status")).toBeNull();
});

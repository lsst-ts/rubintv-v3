import { render, screen } from "@testing-library/react";
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
      : { dates: [], values: {}, camera_groups: [], channels: [], per_day: {}, metadata: {} };
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

test("mosaic suffix route wins over the channel catch-all", async () => {
  renderAt("/local/lsstcam/mosaic");
  expect(await screen.findByText("Mosaic / Movies")).toBeDefined();
});

test("/status resolves to the scan-status view, not a location", async () => {
  renderAt("/status");
  expect(await screen.findByText("Scan status")).toBeDefined();
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

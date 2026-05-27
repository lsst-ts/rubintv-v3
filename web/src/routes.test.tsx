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

test("home renders", async () => {
  renderAt("/");
  // "RubinTV" also appears in the breadcrumb link; assert on the heading.
  expect(
    await screen.findByRole("heading", { name: "RubinTV" }),
  ).toBeDefined();
});

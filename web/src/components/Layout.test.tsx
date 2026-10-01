import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
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

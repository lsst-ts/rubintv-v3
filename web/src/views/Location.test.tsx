import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { routes } from "../routes";

// A location payload with two cameras: one whose primary channel has a latest
// image, one without. Everything else the view reads defaults to empty.
function locationPayload() {
  return {
    name: "local",
    title: "Local",
    has_cluster_status: false,
    camera_groups: [
      {
        label: "Main",
        cameras: [
          {
            name: "lsstcam",
            title: "LSSTCam",
            online: true,
            latest_date: "2026-04-10",
            primary_image:
              "/locations/local/cameras/lsstcam/channels/witness_detector/2026-04-10/000002/image.jpg",
          },
          {
            name: "auxtel",
            title: "AuxTel",
            online: true,
            latest_date: "2026-04-10",
            primary_image: null,
          },
        ],
      },
    ],
  };
}

// Point the location endpoint at a custom camera list (defaults to the two
// image-loading cameras above).
function stubLocation(cameras?: unknown[]) {
  const payload = locationPayload();
  if (cameras) payload.camera_groups[0].cameras = cameras as never;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = { camera_groups: [] };
    if (url.endsWith("/api/locations/local")) {
      body = payload;
    } else if (url.endsWith("/api/locations")) {
      // The location list must name "local", or the route guard reads the URL
      // as pointing at a location this deployment doesn't have and 404s.
      body = [{ name: "local", title: "Local" }];
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

beforeEach(() => stubLocation());

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

test("a camera with a primary image renders it with the shared loading treatment", async () => {
  renderAt("/local");
  // The card thumbnail is the primary-channel image. In jsdom the load event
  // never fires, so we observe the loading state: the same fade-in class and
  // spinner overlay the Channels grid uses.
  const img = (await screen.findByAltText("")) as HTMLImageElement;
  expect(img.getAttribute("src")).toContain("witness_detector");
  expect(img.className).toContain("cam-thumb-img");
  expect(img.className).toContain("chc-img-loading");
  // The shared spinner overlay is present while loading.
  expect(screen.getByLabelText("Loading image")).toBeDefined();
});

test("a camera with no primary image shows the placeholder, not a broken image", async () => {
  renderAt("/local");
  // AuxTel has no primary_image, so its thumb is the shared empty placeholder
  // and it renders no <img>.
  expect(await screen.findByText("no recent frame")).toBeDefined();
  const imgs = screen.getAllByAltText("");
  // Only lsstcam (with an image) contributes an <img>; auxtel does not.
  await waitFor(() => expect(imgs.length).toBe(1));
});

test("distinguishes a stale camera from one that has never had data", async () => {
  stubLocation([
    // A fixed past date is reliably before the current observing day → stale.
    {
      name: "cam_stale",
      title: "Stale Cam",
      online: true,
      latest_date: "2020-01-01",
      primary_image: null,
    },
    // No data ever → nodata.
    {
      name: "cam_nodata",
      title: "Nodata Cam",
      online: true,
      latest_date: null,
      primary_image: null,
    },
  ]);
  renderAt("/local");

  // The two states read differently: "stale" vs "no data".
  const stale = await screen.findByText("stale");
  const nodata = await screen.findByText("no data");
  // Stale carries the amber modifier; nodata falls through to the neutral dot.
  expect(stale.className).toContain("stale");
  expect(nodata.className).not.toContain("stale");

  // Both remain navigable (only config-offline cameras aren't) — each card is
  // a link to its camera.
  expect(screen.getByRole("link", { name: /Stale Cam/ })).toBeDefined();
  expect(screen.getByRole("link", { name: /Nodata Cam/ })).toBeDefined();
});

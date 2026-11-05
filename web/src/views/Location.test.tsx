import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

test("a thumbnail drops its spinner once loaded, or its image once broken", async () => {
  stubLocation([
    {
      name: "a",
      title: "Cam A",
      online: true,
      latest_date: "2026-04-10",
      primary_image: "/locations/local/cameras/a/channels/x/2026-04-10/000001/image.jpg",
    },
    {
      name: "b",
      title: "Cam B",
      online: true,
      latest_date: "2026-04-10",
      primary_image: "/locations/local/cameras/b/channels/x/2026-04-10/000001/image.jpg",
    },
  ]);
  renderAt("/local");
  await waitFor(() => expect(screen.getAllByAltText("")).toHaveLength(2));
  const [a, b] = screen.getAllByAltText("");
  expect(screen.getAllByLabelText("Loading image")).toHaveLength(2);

  fireEvent.load(a);
  await waitFor(() =>
    expect(screen.getAllByLabelText("Loading image")).toHaveLength(1),
  );
  expect(a.className).not.toContain("chc-img-loading");

  // A frame that fails to load falls back to the placeholder.
  fireEvent.error(b);
  expect(await screen.findByText("no recent frame")).toBeDefined();
  expect(screen.getAllByAltText("")).toHaveLength(1);
});

test("an offline camera is shown but not navigable", async () => {
  stubLocation([
    {
      name: "off",
      title: "Off Cam",
      online: false,
      latest_date: "2026-04-10",
      primary_image: "/locations/local/cameras/off/channels/x/2026-04-10/000001/image.jpg",
    },
  ]);
  renderAt("/local");
  const label = await screen.findByText("offline");
  expect(label.getAttribute("title")).toMatch(/disabled in the configuration/);
  // No thumbnail fetch for it: the placeholder says why.
  expect(screen.getByText("no recent data")).toBeDefined();
  expect(screen.queryByRole("link", { name: /Off Cam/ })).toBeNull();
  expect(screen.getByText("Off Cam").closest(".cam-card")?.className).toContain(
    "off",
  );
});

test("a location with cluster status offers it under Apps", async () => {
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/api/locations/local")) {
      return inner(input, init);
    }
    return Promise.resolve(inner(input, init)).then(async (r) => {
      const body = { ...(await r.json()), has_cluster_status: true };
      return { ok: true, json: () => Promise.resolve(body) };
    });
  }) as unknown as typeof fetch;
  renderAt("/local");
  const card = await screen.findByRole("link", { name: /Cluster status/ });
  expect(card.getAttribute("href")).toBe("/detectors");
  expect(screen.getByText("Apps")).toBeDefined();
});

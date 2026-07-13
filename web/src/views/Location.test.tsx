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

beforeEach(() => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/api/locations/local")
      ? locationPayload()
      : { camera_groups: [] };
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

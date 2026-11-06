import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { Mosaic } from "./Mosaic";

// The live mosaic grid on its own: a tile per configured channel at its newest
// seq, the file each asks for (per-seq extension, channel default, png/mp4),
// metadata captions, and the empty state. The route itself is in routes.test.

function stub({
  dates = ["2026-04-10"],
  meta = [
    { channel: "monitor", media_type: "image", meta_columns: ["Exposure", "Detail"] },
    { channel: "focus_movie", media_type: "video", meta_columns: [] },
    { channel: "empty", media_type: "image", meta_columns: [] },
  ] as unknown[] | undefined,
  channels = { monitor: [250, 252], focus_movie: [251] } as Record<string, number[]>,
  extensions = { monitor: { default: "png", exceptions: { "252": "jpg" } } },
} = {}) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (/\/calendar$/.test(url)) {
      body = { dates };
    } else if (/\/cameras\/lsstcam$/.test(url)) {
      body = {
        name: "lsstcam",
        title: "LSSTCam",
        // focus_movie has no configured title: the tile falls back to its name.
        channels: [{ name: "monitor", title: "Monitor" }],
        mosaic_view_meta: meta,
      };
    } else if (/\/metadata\//.test(url)) {
      body = { "252": { Exposure: 30, Detail: { DISPLAY_VALUE: "x" } } };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels, extensions };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

function renderMosaic() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <MemoryRouter initialEntries={["/local/lsstcam/mosaic"]}>
          <Routes>
            <Route path="/:location/:camera/mosaic" element={<Mosaic />} />
          </Routes>
        </MemoryRouter>
      </LiveProvider>
    </QueryClientProvider>,
  );
}

test("each configured channel tiles its newest file, with its captions", async () => {
  stub();
  renderMosaic();
  // Seq 252 was written as a jpg.
  const img = await screen.findByRole("img", { name: "Monitor 252" });
  expect(img.getAttribute("src")).toContain("/monitor/2026-04-10/000252/image.jpg");

  // A video channel with no extension info plays an mp4, titled by its name.
  const movie = screen.getByText("focus_movie").closest("figure")!;
  expect(within(movie).getByText("#251")).toBeDefined();
  expect(movie.querySelector("video")?.getAttribute("src")).toContain(
    "/focus_movie/2026-04-10/000251/image.mp4",
  );
  // A channel with nothing yet tonight gets no tile.
  expect(screen.queryByText("empty")).toBeNull();

  // Caption values: a scalar as-is, an object as a dash (never
  // "[object Object]"), once the metadata lands.
  const tile = img.closest("figure")!;
  await waitFor(() => expect(within(tile).getByText("30")).toBeDefined());
  const detail = within(tile).getByText("Detail").nextElementSibling;
  expect(detail?.textContent).toBe("—");
});

test("a camera with no mosaic configured shows the empty state", async () => {
  stub({ meta: undefined });
  renderMosaic();
  expect(await screen.findByText("No imagery yet for 2026-04-10.")).toBeDefined();
});

test("a still channel with no extension info falls back to png", async () => {
  stub({ channels: { monitor: [7] }, extensions: {} as never });
  renderMosaic();
  const img = await screen.findByRole("img", { name: "Monitor 7" });
  expect(img.getAttribute("src")).toContain("/000007/image.png");
  // No metadata for seq 7: its caption columns read as dashes.
  const values = [...img.closest("figure")!.querySelectorAll("dd")].map(
    (d) => d.textContent,
  );
  expect(values).toEqual(["—", "—"]);
});

test("a camera with no data at all renders nothing yet", async () => {
  stub({ dates: [] });
  const { container } = renderMosaic();
  await waitFor(() =>
    expect(container.querySelector(".mosaic-grid")).not.toBeNull(),
  );
  expect(container.querySelector(".mosaic-tile")).toBeNull();
  expect(screen.queryByText(/No imagery yet/)).toBeNull();
});

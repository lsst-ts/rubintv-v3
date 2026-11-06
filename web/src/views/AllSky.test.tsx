import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { AllSky } from "./AllSky";

// The All Sky panel on its own: which file each tile asks for (per-seq
// extension exceptions, else the channel default, else png/mp4), the empty
// state, defaulting to the newest night, and the date picker keeping the
// URL's other parameters. Live/historical modes are covered in routes.test.

function stub(
  channels: Record<string, number[]>,
  extensions: Record<string, unknown> = {},
) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (/\/cameras\/allsky\/calendar$/.test(url)) {
      body = {
        dates: ["2026-04-10", "2026-04-09"],
        counts: { "2026-04-10": 3, "2026-04-09": 2 },
        max_seq: {},
      };
    } else if (/\/cameras\/allsky$/.test(url)) {
      body = {
        name: "allsky",
        title: "All Sky",
        live_view: true,
        channels: [
          { name: "stills", title: "Current Image" },
          { name: "movies", title: "Current Movie" },
        ],
        mosaic_view_meta: [{ channel: "movies", media_type: "video" }],
      };
    } else if (/\/dates\//.test(url)) {
      body = { per_day: {}, metadata: {}, channels, extensions };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

function Search() {
  return <output>{useLocation().search}</output>;
}

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/:location/:camera"
              element={
                <>
                  <AllSky />
                  <Search />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </LiveProvider>
    </QueryClientProvider>,
  );
}

test("without a date it opens the newest night, live", async () => {
  stub({ stills: [1, 3], movies: [2] });
  renderAt("/local/allsky");
  expect(await screen.findByText("live")).toBeDefined();
  expect(await screen.findByRole("img", { name: /Current Image 3/ })).toBeDefined();
});

test("a seq's own extension wins, then the channel default, then png/mp4", async () => {
  stub(
    { stills: [1, 3], movies: [2] },
    // Seq 3 was written as a jpg; the movie channel declares no extensions.
    { stills: { default: "png", exceptions: { "3": "jpg" } } },
  );
  renderAt("/local/allsky?date=2026-04-10");
  const still = await screen.findByRole("img", { name: /Current Image 3/ });
  expect(still.getAttribute("src")).toContain("/000003/image.jpg");
  await waitFor(() =>
    expect(document.querySelector("video")?.getAttribute("src")).toContain(
      "/movies/2026-04-10/000002/image.mp4",
    ),
  );
});

test("a still channel with no extension info falls back to png", async () => {
  stub({ stills: [4], movies: [] });
  renderAt("/local/allsky?date=2026-04-10");
  const still = await screen.findByRole("img", { name: /Current Image 4/ });
  expect(still.getAttribute("src")).toContain("/000004/image.png");
  // A channel with nothing yet today gets no tile.
  expect(document.querySelector("video")).toBeNull();
});

test("a live night with nothing in any channel says so", async () => {
  stub({ stills: [], movies: [] });
  renderAt("/local/allsky?date=2026-04-10");
  expect(
    await screen.findByText("No imagery yet for 2026-04-10."),
  ).toBeDefined();
});

test("picking a night keeps the URL's other parameters", async () => {
  stub({ stills: [1], movies: [1] });
  localStorage.removeItem("rubintv.datepicker.mode"); // start on Months
  renderAt("/local/allsky?date=2026-04-10&headerless=true");
  fireEvent.click(await screen.findByRole("button", { name: /2026-04-10/ }));
  const dialog = await screen.findByRole("dialog", { name: /Choose date/ });
  fireEvent.click(within(dialog).getByTitle("2026-04-09 · movie"));

  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(
      "?date=2026-04-09&headerless=true",
    ),
  );
  expect(await screen.findByText("historical · 2026-04-09")).toBeDefined();
});

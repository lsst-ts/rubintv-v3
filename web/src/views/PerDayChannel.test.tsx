import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { PerDayChannel } from "./PerDayChannel";

// The night-by-night viewer on its own, for what routes.test doesn't reach: a
// per-day artifact that's an image rather than a movie, the extension
// fallbacks, and a live channel that has never produced anything.

function stub({
  nights = ["2026-04-10"],
  ref = { seq: 12, ext: "png" } as { seq: number; ext?: string } | null,
  extensions = {} as Record<string, unknown>,
} = {}) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (/\/calendar$/.test(url)) {
      body = { dates: nights, per_day_dates: { night_plot: nights } };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = {
        name: "auxtel",
        title: "AuxTel",
        channels: [{ name: "night_plot", title: "Night Plot", per_day: true }],
      };
    } else if (/\/dates\//.test(url)) {
      body = {
        per_day: ref ? { night_plot: ref } : {},
        metadata: {},
        channels: {},
        extensions,
      };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/:location/:camera/:channel"
              element={<PerDayChannel live={false} />}
            />
            <Route
              path="/:location/:camera/:channel/current"
              element={<PerDayChannel live />}
            />
          </Routes>
        </MemoryRouter>
      </LiveProvider>
    </QueryClientProvider>,
  );
}

test("an image artifact shows as an image that opens in a new tab", async () => {
  stub();
  renderAt("/local/auxtel/night_plot?date=2026-04-10");
  const img = await screen.findByRole("img", { name: "night_plot 2026-04-10" });
  expect(img.getAttribute("src")).toMatch(/night_plot.*\.png$/);
  const open = screen.getByRole("link", { name: "Open image in new tab" });
  expect(open.getAttribute("href")).toBe(img.getAttribute("src"));
  expect(open.getAttribute("target")).toBe("_blank");
  expect(screen.queryByRole("link", { name: /Download movie/ })).toBeNull();
  // No exposures that night: no range caption.
  expect(screen.queryByText(/Exposures #/)).toBeNull();
});

test("an entry without its own extension uses the channel default", async () => {
  stub({
    ref: { seq: 12 },
    extensions: { night_plot: { default: "jpg", exceptions: {} } },
  });
  renderAt("/local/auxtel/night_plot?date=2026-04-10");
  const img = await screen.findByRole("img", { name: "night_plot 2026-04-10" });
  expect(img.getAttribute("src")).toMatch(/\.jpg$/);
});

test("with no extension anywhere, the artifact is taken to be a movie", async () => {
  stub({ ref: { seq: 12 } });
  renderAt("/local/auxtel/night_plot?date=2026-04-10");
  expect(await screen.findByRole("link", { name: /Download movie/ })).toBeDefined();
  expect(document.querySelector("video")?.getAttribute("src")).toMatch(/\.mp4$/);
});

test("live, a channel that has never produced anything says so", async () => {
  stub({ nights: [], ref: null });
  renderAt("/local/auxtel/night_plot/current");
  expect(await screen.findByText("No Night Plot yet.")).toBeDefined();
  expect(screen.getByText("LIVE")).toBeDefined();
});

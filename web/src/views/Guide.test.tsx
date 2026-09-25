import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { Guide } from "./Guide";
import type { GuideBlocksOut, GuideConfigOut, ProgramNamesOut } from "../lib/types";

// The view mounts the vendored d3 timeline into jsdom; d3 and astronomy-engine
// are pure JS so the SVG really renders (with the 800px minimum width, since
// jsdom reports no layout).

// jsdom's window.scrollTo only logs "not implemented"; the timeline scrolls
// to today's row on mount and to a block on selection.
beforeEach(() => {
  window.scrollTo = () => {};
});

const config: GuideConfigOut = {
  enabled: true,
  instruments: [
    {
      name: "lsstcam",
      location: "test",
      camera: "lsstcam",
      image_viewer_link: "http://fits.example/{dayObs}_{seqNum:06}",
      quicklook_viewer_link: null,
    },
  ],
  day_start_utc_hour: 12,
  max_gap_minutes: 15,
};

// Two blocks on the 2025-04-12 observing night (UTC 12:00 rollover): one of
// 40 minutes, one of 2 minutes (hidden by the 5-minute filter).
const blocks: GuideBlocksOut = {
  instrument: "lsstcam",
  blocks: [
    {
      program: "BLOCK-T1",
      begin: "2025-04-13T01:00:00.000Z",
      end: "2025-04-13T01:40:00.000Z",
      seq_num_0: 10,
      seq_num_1: 50,
      day_obs: 20250412,
      day_obs_end: 20250412,
      n_exposures: 41,
    },
    {
      program: "BLOCK-T2",
      begin: "2025-04-13T02:00:00.000Z",
      end: "2025-04-13T02:02:00.000Z",
      seq_num_0: 51,
      seq_num_1: 52,
      day_obs: 20250412,
      day_obs_end: 20250412,
      n_exposures: 2,
    },
  ],
  loading: false,
  updated_at: "2025-04-13T03:00:00Z",
  last_exposure_id: 2025041200052,
  exposures: 43,
  error: null,
};

const programs: ProgramNamesOut = {
  names: { "BLOCK-T1": "A named block" },
  source: "snapshot",
  updated_at: null,
  error: null,
};

function mockApi(overrides: { config?: GuideConfigOut; blocks?: GuideBlocksOut } = {}) {
  const table: Record<string, unknown> = {
    "/guide": overrides.config ?? config,
    "/guide/lsstcam/blocks": overrides.blocks ?? blocks,
    "/guide/programs": programs,
  };
  globalThis.fetch = ((url: string) => {
    const path = url.replace(/^.*\/api/, "");
    const body = table[path];
    return Promise.resolve({
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: () => Promise.resolve(body ?? { detail: "not found" }),
    });
  }) as unknown as typeof fetch;
}

function renderGuide(path = "/guide") {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/guide" element={<Guide />} />
          <Route path="/guide/:instrument" element={<Guide />} />
          <Route path="/:location/:camera" element={<p>camera page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("draws the blocks and reports the count", async () => {
  mockApi();
  const { container } = renderGuide();
  await waitFor(() =>
    expect(container.querySelectorAll("rect.block").length).toBeGreaterThan(0),
  );
  // The 2-minute block is filtered out, so exactly one rect on the timeline.
  expect(container.querySelectorAll("rect.block")).toHaveLength(1);
  expect(screen.getByRole("status").textContent).toContain("2 blocks");
  // A row per day from the first block through six months of future.
  expect(container.querySelectorAll(".y-axis .tick").length).toBeGreaterThan(150);
});

test("clicking a block fills the info panel with its details and links", async () => {
  mockApi();
  const { container } = renderGuide();
  const block = await waitFor(() => {
    const el = container.querySelector("rect.block");
    if (!el) throw new Error("no block yet");
    return el;
  });
  fireEvent.click(block);
  expect(screen.getByText("Block Information")).toBeDefined();
  expect(screen.getByText("BLOCK-T1")).toBeDefined();
  expect(screen.getByText("A named block")).toBeDefined();
  // The seq range links into the camera table, filtered to those exposures.
  const range = screen.getByText("10 - 50") as HTMLAnchorElement;
  expect(range.tagName).toBe("A");
  expect(range.getAttribute("href")).toBe(
    "/test/lsstcam?date=2025-04-12&seq_filter=between10_50",
  );
  // The observing day is the link to that night's camera page.
  // (getByRole: the same date is also a y-axis tick label.)
  const rubintv = screen.getByRole("link", { name: "2025-04-12" }) as HTMLAnchorElement;
  expect(rubintv.getAttribute("href")).toBe("/test/lsstcam?date=2025-04-12");
  expect(screen.getByText("External links:")).toBeDefined();
  expect(screen.queryByText("RubinTV")).toBeNull();
  const fits = screen.getByText("FITS image viewer") as HTMLAnchorElement;
  expect(fits.getAttribute("href")).toBe("http://fits.example/20250412_000010");
  expect(fits.getAttribute("target")).toBe("_blank");
  // The day link is an in-app route, so it navigates without a reload.
  fireEvent.click(rubintv);
  expect(await screen.findByText("camera page")).toBeDefined();
});

test("search finds programs by description and selects them", async () => {
  mockApi();
  const { container } = renderGuide();
  await waitFor(() =>
    expect(container.querySelectorAll("rect.block").length).toBeGreaterThan(0),
  );
  const input = screen.getByLabelText("Search programs") as HTMLInputElement;
  fireEvent.input(input, { target: { value: "named" } });
  const hit = await screen.findByText("BLOCK-T1", { selector: ".search-program" });
  fireEvent.click(hit);
  expect(screen.getByText("Block Information")).toBeDefined();
  expect(container.querySelector("rect.block.selected")).not.toBeNull();
});

test("shows the sweep progress while the backend is still loading", async () => {
  mockApi({ blocks: { ...blocks, blocks: [], loading: true, exposures: 1234 } });
  renderGuide();
  expect(await screen.findByText(/Sweeping ConsDB/)).toBeDefined();
  expect(screen.getByText(/1,234 exposures/)).toBeDefined();
});

test("explains when the guide is not configured", async () => {
  mockApi({ config: { ...config, enabled: false, instruments: [] } });
  renderGuide();
  expect(await screen.findByText(/not configured/)).toBeDefined();
});

test("an unknown instrument in the URL is reported", async () => {
  mockApi();
  renderGuide("/guide/nope");
  expect(await screen.findByText(/No guide for instrument/)).toBeDefined();
});

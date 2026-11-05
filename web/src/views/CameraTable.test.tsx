import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { openLiveSockets, pushLiveMessage } from "../test-setup";
import { CameraTable } from "./CameraTable";

// The camera table's toolbar and states, rendered on its own (no app shell):
// row density and the column picker's views (both remembered per browser),
// column toggles and sorting, the streamed-metadata progress note, the
// Nightly Summary link, the "since last image" clock, and the filtered-empty
// notice. Most table flows run through the full router in routes.test.

const TODAY = "2026-04-11";

function stub({
  calendar = [TODAY, "2026-04-10"],
  camera = {} as Record<string, unknown>,
  metadata = {
    "10": { Exposure: 30, Filter: "z_20" },
    "11": { Exposure: 15, Filter: "r_03", "Date begin": "2026-04-11T03:00:00" },
  } as Record<string, unknown>,
  hasNightReport = false,
} = {}) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (/\/cameras\/auxtel\/calendar$/.test(url)) {
      body = { dates: calendar };
    } else if (/\/cameras\/auxtel$/.test(url)) {
      body = {
        name: "auxtel",
        title: "AuxTel",
        channels: [],
        metadata_columns: { Exposure: "Exposure time", Filter: "Filter" },
        ...camera,
      };
    } else if (/\/metadata\//.test(url)) {
      body = metadata;
    } else if (/\/dates\//.test(url)) {
      body = {
        per_day: {},
        metadata: {},
        channels: { c: [10, 11] },
        extensions: {},
        has_night_report: hasNightReport,
      };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  localStorage.clear();
  stub();
});
afterEach(() => vi.restoreAllMocks());

function renderTable(path = `/local/auxtel?date=${TODAY}`) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/:location/:camera" element={<CameraTable />} />
            <Route
              path="/:location/:camera/nightly-summary"
              element={<p>summary page</p>}
            />
          </Routes>
        </MemoryRouter>
      </LiveProvider>
    </QueryClientProvider>,
  );
}

const table = () => document.querySelector<HTMLElement>(".data-table")!;
const seqOrder = () =>
  [...document.querySelectorAll("td.seq")].map((td) => td.textContent);

test("row density is chosen from a menu and remembered", async () => {
  const { unmount } = renderTable();
  await screen.findByText("10");
  expect(table().className).toContain("dens-regular");

  fireEvent.click(screen.getByRole("button", { name: /Density/ }));
  const menu = screen.getByRole("menu", { name: "Row density" });
  expect(
    within(menu).getByRole("menuitemradio", { name: "regular" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "compact" }));

  expect(screen.queryByRole("menu", { name: "Row density" })).toBeNull();
  expect(table().className).toContain("dens-compact");
  expect(localStorage.getItem("rubintv.density")).toBe("compact");

  unmount();
  renderTable();
  await screen.findByText("10");
  expect(table().className).toContain("dens-compact");
});

test("the density menu toggles shut from its button", async () => {
  renderTable();
  await screen.findByText("10");
  const btn = screen.getByRole("button", { name: /Density/ });
  fireEvent.click(btn);
  expect(btn.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(btn);
  expect(screen.queryByRole("menu", { name: "Row density" })).toBeNull();
});

test("the column picker's Reorder view is remembered", async () => {
  const { unmount } = renderTable();
  await screen.findByText("10");
  fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Reorder" }));

  expect(screen.getByText("Drag to reorder the shown columns")).toBeDefined();
  // The catalogue's search belongs to the Select view only.
  expect(screen.queryByLabelText("Search columns")).toBeNull();
  expect(localStorage.getItem("rubintv.colsMode")).toBe("reorder");

  unmount();
  renderTable();
  await screen.findByText("10");
  fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
  expect(
    screen.getByRole("tab", { name: "Reorder" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "Select" }));
  expect(screen.getByLabelText("Search columns")).toBeDefined();
});

test("density and picker view still work where storage is blocked", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  renderTable();
  await screen.findByText("10");
  fireEvent.click(screen.getByRole("button", { name: /Density/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "compact" }));
  expect(table().className).toContain("dens-compact");

  fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Reorder" }));
  expect(screen.getByText("Drag to reorder the shown columns")).toBeDefined();
});

test("unticking a column in the picker hides it from the table", async () => {
  renderTable();
  await screen.findByText("z_20");
  // Exposure and Filter are configured; "Date begin" is data-only (hidden).
  fireEvent.click(screen.getByRole("button", { name: /Columns 2\/3/ }));
  const item = screen.getByText("Filter", { selector: ".scrolling-title-text" })
    .closest("label")!;
  fireEvent.click(within(item).getByRole("checkbox"));

  await waitFor(() => expect(screen.queryByText("z_20")).toBeNull());
  expect(screen.getByRole("button", { name: /Columns 1\/3/ })).toBeDefined();
  expect(item.className).toContain("dim");
});

test("clicking a column label sorts by it, then reverses", async () => {
  renderTable();
  await screen.findByText("10");
  expect(seqOrder()).toEqual(["11", "10"]); // default: newest first

  const exposure = screen.getByRole("button", { name: /^Exposure/ });
  fireEvent.click(exposure); // descending: 30 (seq 10) first
  await waitFor(() => expect(seqOrder()).toEqual(["10", "11"]));
  fireEvent.click(exposure); // ascending
  await waitFor(() => expect(seqOrder()).toEqual(["11", "10"]));
});

test("streamed metadata shows its progress until the stream completes", async () => {
  renderTable();
  await screen.findByText("10");
  act(() => openLiveSockets());
  const frame = { location: "local", camera: "auxtel", date: TODAY };
  act(() =>
    pushLiveMessage({
      type: "metadataChunk",
      ...frame,
      seq: 0,
      data: { "12": { Exposure: 5 }, "13": { Exposure: 6 } },
    }),
  );
  expect(
    (await screen.findByText(/loading metadata/)).textContent,
  ).toBe("loading metadata… 2 rows");

  act(() => pushLiveMessage({ type: "metadataComplete", ...frame, total: 2 }));
  await waitFor(() => expect(screen.queryByText(/loading metadata/)).toBeNull());
});

test("a night with a Nightly Summary links to it", async () => {
  stub({ hasNightReport: true });
  renderTable();
  fireEvent.click(await screen.findByRole("link", { name: "Nightly Summary" }));
  expect(await screen.findByText("summary page")).toBeDefined();
});

test("today's table shows the camera's time-since-last-image clock", async () => {
  stub({
    camera: { time_since_clock: { label: "Since last image" } },
  });
  renderTable();
  expect(await screen.findByText(/Since last image/)).toBeDefined();
});

test("a past night shows no time-since clock", async () => {
  stub({
    camera: { time_since_clock: { label: "Since last image" } },
  });
  renderTable("/local/auxtel?date=2026-04-10");
  await screen.findByText("10");
  expect(screen.queryByText(/Since last image/)).toBeNull();
});

test("filters that match nothing say so rather than showing no data", async () => {
  // Seeded from the URL: a Seq.No range with no rows in it.
  renderTable(`/local/auxtel?date=${TODAY}&seq_filter=gte50`);
  expect(
    await screen.findByText("No rows match the active filter."),
  ).toBeDefined();
});

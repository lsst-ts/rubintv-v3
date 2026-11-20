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
import { queryKeys } from "../lib/liveQuery";
import { LiveProvider } from "../lib/LiveContext";
import { NightReport } from "./NightReport";

// The Nightly Summary's text tabs (paragraph, key/value and link sections),
// switching tabs, and keeping the chosen tab across a live refresh. Plot
// groups and the enlarge dialog are in routes.test.

const REPORT = {
  date: "2026-04-10",
  exists: true,
  text: [
    { type: "multiline", title: "Night log", content: "Dome opened 23:10\nClouds 02:00" },
    {
      type: "links",
      title: "Links",
      content: [
        { text: "Logbook", url: "https://example.org/log" },
        { text: "Local page", url: "/rubintv/summit" },
        { text: "Sneaky", url: "javascript:alert(1)" },
      ],
    },
    { type: "keyvalues", title: "Night log", content: { seeing: "0.7" } },
  ],
  plots: [{ key: "k1", group: "Seeing", filename: "fwhm.png" }],
};

function stub() {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const body = /\/nightly-summary\//.test(String(input)) ? REPORT : {};
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

function renderReport(qc = createQueryClient()) {
  render(
    <QueryClientProvider client={qc}>
      <LiveProvider>
        <MemoryRouter initialEntries={["/local/auxtel/nightly-summary?date=2026-04-10"]}>
          <Routes>
            <Route path="/:location/:camera/nightly-summary" element={<NightReport />} />
          </Routes>
        </MemoryRouter>
      </LiveProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const tabs = () => screen.getAllByRole("tab").map((t) => t.textContent);
const panel = () => screen.getByRole("tabpanel");

beforeEach(stub);

test("each section gets a tab labelled with its kind; plots show their count", async () => {
  renderReport();
  await screen.findByRole("tab", { name: /Links/ });
  // Two sections share a title: both get tabs.
  expect(tabs()).toEqual(["Night logtext", "Linkslinks", "Night logkey/val", "Seeing1"]);
});

test("a paragraph section keeps its line breaks", async () => {
  renderReport();
  await screen.findByRole("tab", { name: /Links/ });
  expect(within(panel()).getByText("MULTILINE")).toBeDefined();
  expect(panel().querySelector("pre")?.textContent).toBe(
    "Dome opened 23:10\nClouds 02:00",
  );
});

test("links open in a new tab, and a script URL is rendered inert", async () => {
  renderReport();
  fireEvent.click(await screen.findByRole("tab", { name: /Links/ }));
  expect(within(panel()).getByText("LINKS")).toBeDefined();
  const link = (text: string) =>
    within(panel()).getByText(text).closest("a") as HTMLAnchorElement;

  expect(link("Logbook").getAttribute("href")).toBe("https://example.org/log");
  expect(link("Logbook").getAttribute("target")).toBe("_blank");
  expect(link("Local page").getAttribute("href")).toBe("/rubintv/summit");
  // Operator-authored text: a javascript: URL must not become a live href.
  expect(link("Sneaky").hasAttribute("href")).toBe(false);
  expect(link("Sneaky").getAttribute("aria-disabled")).toBe("true");
});

test("switching tabs shows that section; a live refresh keeps the choice", async () => {
  const qc = renderReport();
  const kv = (await screen.findAllByRole("tab", { name: /Night log/ }))[1];
  fireEvent.click(kv);
  expect(kv.getAttribute("aria-selected")).toBe("true");
  expect(within(panel()).getByText("KEY / VALUE")).toBeDefined();
  expect(within(panel()).getByText("0.7")).toBeDefined();

  // A refreshed report that still has the section keeps it selected...
  const key = queryKeys.nightReport("local", "auxtel", "2026-04-10");
  act(() => {
    qc.setQueryData(key, {
      ...REPORT,
      text: [...REPORT.text, { type: "multiline", title: "Late", content: "x" }],
    });
  });
  await screen.findByRole("tab", { name: /Late/ });
  expect(within(panel()).getByText("0.7")).toBeDefined();

  // ...and one without it falls back to the first tab.
  act(() => {
    qc.setQueryData(key, { ...REPORT, text: REPORT.text.slice(0, 1) });
  });
  await waitFor(() => expect(tabs()).toEqual(["Night logtext", "Seeing1"]));
  expect(within(panel()).getByText("MULTILINE")).toBeDefined();
});

test("a report that disappears on refresh says there's none", async () => {
  const qc = renderReport();
  await screen.findByRole("tab", { name: /Links/ });
  act(() => {
    qc.setQueryData(queryKeys.nightReport("local", "auxtel", "2026-04-10"), {
      date: "2026-04-10",
      exists: false,
      text: [],
      plots: [],
    });
  });
  expect(await screen.findByText("No summary for this date.")).toBeDefined();
});

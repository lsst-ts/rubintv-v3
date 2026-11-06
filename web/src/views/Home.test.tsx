import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { Home } from "./Home";

// The landing page's Apps section: Cluster status when any location reports
// it, a card per mounted sub-app, then the always-present Scan status and
// Admin pages. Location cards and the single-location redirect are covered in
// routes.test.

function stub({
  clusterStatus = false,
  subapps = [] as string[],
  fail = false,
} = {}) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    // A 4xx: the query client doesn't retry those, so the error shows at once.
    if (fail) {
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({}),
      });
    }
    let body: unknown = {};
    if (url.endsWith("/api/locations")) {
      body = [
        { name: "summit", title: "Summit", has_cluster_status: clusterStatus },
        { name: "tts", title: "TTS", is_teststand: true },
      ];
    } else if (url.endsWith("/api/subapps")) {
      body = { mounted: subapps };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

function renderHome() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const card = (name: string) =>
  screen.getByText(name, { selector: ".loc-name" }).closest("a")!;

test("the Apps section offers cluster status and each mounted sub-app", async () => {
  stub({ clusterStatus: true, subapps: ["/rubintv/ddv", "/rubintv/exp_checker"] });
  renderHome();
  await screen.findByText("DDV");

  expect(card("Cluster status").getAttribute("href")).toBe("/detectors");
  // A sub-app card names the app (short ids upper-cased, others title-cased)
  // and shows its mount path; it's a plain link out of the SPA.
  const ddv = card("DDV");
  expect(ddv.getAttribute("href")).toBe("/rubintv/ddv");
  expect(within(ddv).getByText("/rubintv/ddv")).toBeDefined();
  expect(card("Exp_checker").getAttribute("href")).toBe("/rubintv/exp_checker");
  expect(card("Scan status").getAttribute("href")).toBe("/status");
  expect(card("Admin").getAttribute("href")).toBe("/admin");
});

test("without cluster status or sub-apps, Apps still has Scan status and Admin", async () => {
  stub();
  renderHome();
  await screen.findByText("Summit");
  expect(screen.queryByText("Cluster status", { selector: ".loc-name" })).toBeNull();
  expect(card("Scan status")).toBeDefined();
  expect(card("Admin")).toBeDefined();
});

test("a failed locations fetch says so instead of showing an empty launcher", async () => {
  stub({ fail: true });
  renderHome();
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not load locations.",
  );
});

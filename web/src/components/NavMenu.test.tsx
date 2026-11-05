import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { NavMenu } from "./NavMenu";

// The hamburger drawer: wayfinding to Home, every location and every app, plus
// the theme picker. Each link closes the drawer, as do Escape and a click
// outside it.

function stub({
  clusterStatus = false,
  subapps = [] as string[],
} = {}) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith("/api/locations")) {
      body = [
        { name: "summit", title: "Summit", has_cluster_status: clusterStatus },
        { name: "base", title: "Base", has_cluster_status: false },
      ];
    } else if (url.endsWith("/api/subapps")) {
      body = { mounted: subapps };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

function renderMenu() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <p>Page body</p>
        <NavMenu />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const trigger = () => screen.getByRole("button", { name: "Menu" });
const openMenu = async () => {
  fireEvent.click(trigger());
  return screen.findByRole("menu");
};

test("opens a drawer listing home, every location, the apps and appearance", async () => {
  stub({ clusterStatus: true, subapps: ["/rubintv/ddv", "/rubintv/exp_checker/"] });
  renderMenu();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");

  const menu = await openMenu();
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  const item = (name: string) => within(menu).findByRole("menuitem", { name });

  expect((await item("Home")).getAttribute("href")).toBe("/");
  expect((await item("Summit")).getAttribute("href")).toBe("/summit");
  expect((await item("Base")).getAttribute("href")).toBe("/base");
  expect((await item("Cluster status")).getAttribute("href")).toBe(
    "/detectors",
  );
  // Sub-apps are plain anchors to their mount path: a short id is upper-cased,
  // a longer one title-cased, and a trailing slash doesn't hide the id.
  expect((await item("DDV")).getAttribute("href")).toBe("/rubintv/ddv");
  expect((await item("Exp_checker")).getAttribute("href")).toBe(
    "/rubintv/exp_checker/",
  );
  expect((await item("Scan status")).getAttribute("href")).toBe("/status");
  expect((await item("Admin")).getAttribute("href")).toBe("/admin");
  expect(
    within(menu).getByRole("group", { name: "Color theme" }),
  ).toBeDefined();
});

test("cluster status is offered only when a location has it", async () => {
  stub({ clusterStatus: false });
  renderMenu();
  const menu = await openMenu();
  await within(menu).findByRole("menuitem", { name: "Summit" });
  expect(within(menu).queryByRole("menuitem", { name: "Cluster status" }))
    .toBeNull();
});

test("the trigger toggles the drawer shut again", async () => {
  stub();
  renderMenu();
  await openMenu();
  fireEvent.click(trigger());
  expect(screen.queryByRole("menu")).toBeNull();
});

test("following a link closes the drawer", async () => {
  stub();
  renderMenu();
  const menu = await openMenu();
  fireEvent.click(await within(menu).findByRole("menuitem", { name: "Base" }));
  expect(screen.queryByRole("menu")).toBeNull();
});

test("Escape and an outside click close the drawer; inside clicks don't", async () => {
  stub();
  renderMenu();
  const menu = await openMenu();

  // Interacting inside (the theme picker) keeps it open.
  fireEvent.mouseDown(within(menu).getByRole("button", { name: "Dark theme" }));
  expect(screen.queryByRole("menu")).not.toBeNull();
  // Other keys are ignored.
  fireEvent.keyDown(document, { key: "Enter" });
  expect(screen.queryByRole("menu")).not.toBeNull();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();

  await openMenu();
  fireEvent.mouseDown(screen.getByText("Page body"));
  expect(screen.queryByRole("menu")).toBeNull();
});

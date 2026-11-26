import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { routes } from "../routes";

// What the app does when something throws while drawing: a view's failure is
// shown inside the shell, which keeps working, and a failure of the shell
// itself gets a page of its own rather than react-router's.
//
// The real route table is used, with the Status view swapped for one that
// throws on the payload it is given and the Layout for one that can be told
// to throw.

const probe = vi.hoisted(() => ({
  payloads: [] as string[],
  fetches: 0,
  shellThrows: false,
}));

vi.mock("../views/Status", () => ({
  Status: () => {
    const { data } = useQuery({
      queryKey: ["probe"],
      queryFn: () => {
        probe.fetches += 1;
        return Promise.resolve(probe.payloads.shift() ?? "good");
      },
      staleTime: Infinity,
    });
    if (data === "bad") throw new Error("Cannot read the bad payload");
    // Anything can be thrown, not only an Error.
    if (data === "words") throw "plain words";
    if (data === "null") throw null;
    return <p>Status says {data ?? "nothing yet"}</p>;
  },
}));

vi.mock("./Layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Layout")>();
  return {
    Layout: () => {
      if (probe.shellThrows) throw new Error("The shell broke");
      return <actual.Layout />;
    },
  };
});

beforeEach(() => {
  probe.payloads = [];
  probe.fetches = 0;
  probe.shellThrows = false;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const body = String(input).endsWith("/api/locations")
      ? [
          { name: "summit", title: "Summit" },
          { name: "base", title: "Base" },
        ]
      : { camera_groups: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
  // React reports each caught error on the console; that is expected here.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>,
  );
  return router;
}

test("a view that throws is reported inside the shell, which stays", async () => {
  probe.payloads = ["bad"];
  renderAt("/status");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("This page hit an error");
  // What was thrown is shown, for whoever reports it.
  expect(alert.textContent).toContain("Cannot read the bad payload");
  // The header is still there, and the error is drawn in the content column.
  expect(screen.getByRole("banner")).toBeDefined();
  expect(alert.closest("main.app-content")).not.toBeNull();
  expect(document.title).toBe("Error · RubinTV");
});

test("something thrown that isn't an Error is shown as it reads", async () => {
  probe.payloads = ["words"];
  renderAt("/status");
  expect((await screen.findByRole("alert")).textContent).toContain("plain words");
});

test("a throw that carries nothing shows the page without a detail", async () => {
  probe.payloads = ["null"];
  renderAt("/status");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("This page hit an error");
  expect(alert.querySelector("code")).toBeNull();
});

test("going to another page clears the error", async () => {
  probe.payloads = ["bad"];
  const router = renderAt("/status");
  await screen.findByRole("alert");
  await router.navigate("/nowhere/at/all/down/here");
  expect(await screen.findByText("Page not found")).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Try again draws the view from a fresh fetch, not the cached payload", async () => {
  probe.payloads = ["bad", "good"];
  renderAt("/status");
  await screen.findByRole("alert");
  expect(probe.fetches).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Status says good")).toBeDefined();
  expect(probe.fetches).toBe(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Try again on a view that still throws shows the error again", async () => {
  probe.payloads = ["bad", "bad"];
  renderAt("/status");
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(probe.fetches).toBe(2));
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(screen.getByRole("banner")).toBeDefined();
});

test("a throw in the shell itself gets a page with a reload and a way home", async () => {
  probe.shellThrows = true;
  renderAt("/status");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("RubinTV hit an error");
  expect(alert.textContent).toContain("The shell broke");
  expect(screen.queryByRole("banner")).toBeNull();
  const real = window.location;
  const reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...real, reload },
  });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: real });
  }
  // A plain link, so following it loads the app afresh.
  expect(
    screen.getByRole("link", { name: "Go to home" }).getAttribute("href"),
  ).toMatch(/\/$/);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

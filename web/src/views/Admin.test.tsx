import { render, screen, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { applyLiveMessage } from "../lib/liveQuery";
import { Admin } from "./Admin";

// Records POST bodies so we can assert what each control box sends.
let posts: { url: string; body: unknown }[] = [];

function stub(redisEnabled = true, isRelease = true) {
  posts = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, detail: "done" }),
      });
    }
    let body: unknown = {};
    if (url.endsWith("/admin/status")) {
      body = {
        version: "3.0.0",
        git_sha: "abc1234",
        commit_date: "2026-07-02",
        is_release: isRelease,
        redis_enabled: redisEnabled,
        cache_enabled: true,
        witness_detector_key: "RUBINTV_CONTROL_WITNESS_DETECTOR",
      };
    } else if (url.endsWith("/admin/menus")) {
      body = {
        menus: [
          {
            title: "AOS Pipeline",
            key: "RUBINTV_CONTROL_AOS_PIPELINE",
            items: [{ label: "DANISH" }, { label: "TIE" }],
          },
        ],
      };
    } else if (url.endsWith("/admin/controls")) {
      body = { values: {} };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

function renderAdmin(qc: ReturnType<typeof createQueryClient>) {
  return render(
    <QueryClientProvider client={qc}>
      <LiveProvider>
        <MemoryRouter>
          <Admin />
        </MemoryRouter>
      </LiveProvider>
    </QueryClientProvider>,
  );
}

test("shows version, renders menu box, and sends the chosen value", async () => {
  stub();
  const qc = createQueryClient();
  renderAdmin(qc);

  // Version line carries the git sha and commit date alongside the version.
  expect(
    await screen.findByText("v3.0.0 · abc1234 · 2026-07-02"),
  ).toBeDefined();
  expect(await screen.findByText("AOS Pipeline")).toBeDefined();

  // The menu's first option (DANISH) sends on click.
  (await screen.findByText("AOS Pipeline"))
    .closest(".admin-box")!
    .querySelector("button")!
    .click();

  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0].url).toContain("/admin/controls/set");
  expect(posts[0].body).toEqual({
    key: "RUBINTV_CONTROL_AOS_PIPELINE",
    value: "DANISH",
  });
});

test("local dev drops the version, showing just sha and date", async () => {
  stub(true, false);
  const qc = createQueryClient();
  renderAdmin(qc);

  // Non-release build: the noisy setuptools-scm version is dropped; only the
  // sha and commit date remain.
  expect(await screen.findByText("abc1234 · 2026-07-02")).toBeDefined();
  expect(screen.queryByText(/v3\.0\.0/)).toBeNull();
});

test("live readback updates the menu's current value", async () => {
  stub();
  const qc = createQueryClient();
  renderAdmin(qc);
  await screen.findByText("AOS Pipeline");

  act(() =>
    applyLiveMessage(qc, {
      type: "controlReadback",
      data: { controls: { RUBINTV_CONTROL_AOS_PIPELINE: "TIE" } },
    }),
  );

  expect(await screen.findByText("TIE")).toBeDefined();
});

test("flush redis requires a confirm click before firing", async () => {
  stub();
  const qc = createQueryClient();
  renderAdmin(qc);

  const flush = await screen.findByRole("button", { name: "Flush Redis" });
  flush.click(); // arms, does not fire
  expect(posts.length).toBe(0);

  const confirm = await screen.findByRole("button", {
    name: /Flush Redis — confirm/,
  });
  confirm.click();
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0].url).toContain("/admin/flush-redis");
});

test("all redis-writing actions are disabled when redis is not configured", async () => {
  stub(false);
  const qc = createQueryClient();
  renderAdmin(qc);
  // Wait for the status query to resolve (version appears) before asserting
  // the redis-gated disabled state, which depends on it. The version line now
  // also carries the git sha and commit date, so match a substring.
  await screen.findByText(/v3\.0\.0/);

  const isDisabled = (name: string | RegExp) =>
    (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

  await waitFor(() => {
    // Every action that writes to Redis is greyed together — not just Flush
    // Redis; Reset Head Node and the control Send buttons too.
    expect(isDisabled("Flush Redis")).toBe(true);
    expect(isDisabled("Reset Head Node")).toBe(true);
    // The AOS Pipeline menu's Send, the arbitrary key/value Send, and the
    // witness Send are all disabled (there are several "Send" buttons).
    const sends = screen.getAllByRole("button", { name: "Send" });
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  // Flush historical cache does NOT touch Redis, so it stays clickable.
  expect(isDisabled("Flush historical cache")).toBe(false);
});

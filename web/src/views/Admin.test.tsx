import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

// Make every POST fail: with a JSON detail (an HTTP error the server
// explains), a non-JSON body (only the status is known), or no response at all.
function failPosts(kind: "detail" | "bare" | "network") {
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return inner(input, init);
    if (kind === "network") return Promise.reject(new TypeError("offline"));
    return Promise.resolve({
      ok: false,
      status: 503,
      json: () =>
        kind === "detail"
          ? Promise.resolve({ detail: "redis is not configured" })
          : Promise.reject(new SyntaxError("not json")),
    });
  }) as unknown as typeof fetch;
}

const feedback = () => screen.findByRole("status");
const boxFor = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest(
    ".admin-box",
  ) as HTMLElement;

test("a menu sends whichever option is picked", async () => {
  stub();
  renderAdmin(createQueryClient());
  const box = await boxFor("AOS Pipeline");
  fireEvent.change(within(box).getByRole("combobox"), {
    target: { value: "TIE" },
  });
  fireEvent.click(within(box).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].body).toEqual({
    key: "RUBINTV_CONTROL_AOS_PIPELINE",
    value: "TIE",
  });
  expect((await feedback()).textContent).toBe("AOS Pipeline: done");
});

test("any key/value pair can be set once a key is given", async () => {
  stub();
  renderAdmin(createQueryClient());
  const box = await boxFor("Set key / value");
  const send = within(box).getByRole("button", { name: "Send" });
  expect((send as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(within(box).getByLabelText("control key"), {
    target: { value: "RUBINTV_X" },
  });
  fireEvent.change(within(box).getByLabelText("control value"), {
    target: { value: "on" },
  });
  fireEvent.click(send);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].url).toContain("/admin/controls/set");
  expect(posts[0].body).toEqual({ key: "RUBINTV_X", value: "on" });
  const msg = await feedback();
  expect(msg.textContent).toBe("set RUBINTV_X: done");
  expect(msg.className).toContain("ok");
});

test("the witness detector is set from its own box", async () => {
  stub();
  renderAdmin(createQueryClient());
  const box = await boxFor("Witness Detector");
  fireEvent.change(within(box).getByLabelText("witness detector value"), {
    target: { value: "R22_S11" },
  });
  fireEvent.click(within(box).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].url).toContain("/admin/witness-detector");
  expect(posts[0].body).toEqual({ key: "", value: "R22_S11" });
});

test("reset head node and flush historical each fire after a confirm", async () => {
  stub();
  renderAdmin(createQueryClient());
  fireEvent.click(await screen.findByRole("button", { name: "Reset Head Node" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Reset — confirm/ }),
  );
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].url).toContain("/admin/reset-head-node");

  fireEvent.click(screen.getByRole("button", { name: "Flush historical cache" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Flush cache — confirm/ }),
  );
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1].url).toContain("/admin/flush-historical");
  expect((await feedback()).textContent).toBe("Flush historical cache: done");
});

test.each([
  ["detail", "redis is not configured"],
  ["bare", "503"],
] as const)(
  "a refused action says why (%s body)",
  async (kind, why) => {
    stub();
    failPosts(kind);
    renderAdmin(createQueryClient());
    const box = await boxFor("AOS Pipeline");
    fireEvent.click(within(box).getByRole("button", { name: "Send" }));
    const msg = await feedback();
    expect(msg.textContent).toBe(
      `AOS Pipeline failed — POST /admin/controls/set -> ${why}`,
    );
    expect(msg.className).toContain("err");
  },
);

test("an action that never reaches the server reports the error", async () => {
  stub();
  failPosts("network");
  renderAdmin(createQueryClient());
  fireEvent.click(await screen.findByRole("button", { name: "Flush historical cache" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Flush cache — confirm/ }),
  );
  expect((await feedback()).textContent).toBe(
    "Flush historical cache failed — TypeError: offline",
  );
});

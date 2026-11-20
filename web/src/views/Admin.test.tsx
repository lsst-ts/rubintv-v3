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

// `access` is what /admin/status says about the caller: a site admin signed
// in as "tester" unless overridden (user null: no login reached the app).
// `readbacks` is what /admin/controls returns: full *_READBACK key -> value.
function stub(
  redisEnabled = true,
  isRelease = true,
  access: { isAdmin?: boolean; user?: string | null } = {},
  readbacks: Record<string, string> = {},
) {
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
        is_admin: access.isAdmin ?? true,
        user: access.user === undefined ? "tester" : access.user,
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
      body = { values: readbacks };
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

  // Picking a menu value sends it.
  await pickIn("AOS Pipeline", "DANISH");

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

test("a deployed dev build drops the version's +g<sha>, which repeats the sha", async () => {
  stub();
  // A build between tags: setuptools-scm's version carries the commit as a
  // local part, the same commit the sha beside it names.
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const resp = await inner(input, init);
    if (!String(input).endsWith("/admin/status")) return resp;
    const body = (await resp.json()) as Record<string, unknown>;
    return {
      ok: true,
      json: () => Promise.resolve({ ...body, version: "0.1.dev400+gabc1234de" }),
    };
  }) as typeof fetch;
  renderAdmin(createQueryClient());
  expect(
    await screen.findByText("v0.1.dev400 · abc1234 · 2026-07-02"),
  ).toBeDefined();
});

test("live readback updates the menu's current value", async () => {
  stub();
  const qc = createQueryClient();
  renderAdmin(qc);
  expect(await currentIn("AOS Pipeline")).toBe("—");

  // The backend keys readbacks by their full *_READBACK name. AI_DONUT isn't
  // one of this menu's options, so only the readback line can show it.
  act(() =>
    applyLiveMessage(qc, {
      type: "controlReadback",
      data: { controls: { RUBINTV_CONTROL_AOS_PIPELINE_READBACK: "AI_DONUT" } },
    }),
  );

  await waitFor(async () =>
    expect(await currentIn("AOS Pipeline")).toBe("AI_DONUT"),
  );
});

test("current values show on load, from the readbacks the server holds", async () => {
  stub(true, true, {}, {
    RUBINTV_CONTROL_AOS_PIPELINE_READBACK: "AI_DONUT",
    RUBINTV_CONTROL_WITNESS_DETECTOR_READBACK: "203",
    // A readback stored under the bare control key is not a readback.
    RUBINTV_CONTROL_AOS_PIPELINE: "TIE",
  });
  renderAdmin(createQueryClient());
  await waitFor(async () =>
    expect(await currentIn("AOS Pipeline")).toBe("AI_DONUT"),
  );
  expect(await currentIn("Witness Detector")).toBe("203");
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
    // The menus' pickers, the arbitrary key/value Send and the witness Send
    // are all disabled (there are several of each).
    const sends = [
      ...screen.getAllByRole("button", { name: "Send" }),
      ...screen.getAllByRole("button", { name: /Send a value/ }),
    ];
    expect(sends.length).toBeGreaterThan(2);
    expect(sends.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  // Flush historical cache does NOT touch Redis, so it stays clickable.
  expect(isDisabled("Flush historical cache")).toBe(false);
});

test("the header says who is signed in", async () => {
  stub();
  const qc = createQueryClient();
  renderAdmin(qc);
  expect(await screen.findByText("· signed in as tester")).toBeDefined();
  // An admin needs no explanation.
  expect(screen.queryByRole("note")).toBeNull();
});

test("a non-admin is told why up front and every action is disabled", async () => {
  stub(true, true, { isAdmin: false, user: "bob" });
  const qc = createQueryClient();
  renderAdmin(qc);

  expect((await screen.findByRole("note")).textContent).toBe(
    "Signed in as bob, who isn't an admin for this site, so the controls below are disabled.",
  );
  // Every action button, including the one that doesn't need Redis.
  const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every((b) => b.disabled)).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Flush historical cache" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("with no login at all, the note points at the deployment", async () => {
  stub(true, true, { isAdmin: false, user: null });
  const qc = createQueryClient();
  renderAdmin(qc);
  expect((await screen.findByRole("note")).textContent).toMatch(
    /^No login reached the app, so the controls below are disabled\./,
  );
  expect(screen.queryByText(/signed in as/)).toBeNull();
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

const boxFor = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest(
    ".admin-box",
  ) as HTMLElement;

// The outcome line in a box: the action's result, stamped with the time.
const statusIn = async (title: string) =>
  within(await boxFor(title)).findByRole("status");
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stamped = (text: string) =>
  new RegExp(`^${escapeRe(text)} · \\d\\d:\\d\\d:\\d\\d$`);

// Open a menu box's list of values and pick one.
async function pickIn(title: string, value: string) {
  const box = await boxFor(title);
  fireEvent.click(within(box).getByRole("button", { name: /Send a value/ }));
  fireEvent.click(within(box).getByRole("menuitem", { name: value }));
}

// The "Current:" value shown in a control's box.
const currentIn = async (title: string) =>
  (await boxFor(title)).querySelector(".admin-readback strong")!.textContent;

test("a menu sends a value as soon as it's picked, and says so in its box", async () => {
  stub();
  renderAdmin(createQueryClient());
  const box = await boxFor("AOS Pipeline");
  // Nothing is offered, let alone sent, until the list is opened.
  expect(within(box).queryByRole("menu")).toBeNull();
  await pickIn("AOS Pipeline", "TIE");
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].body).toEqual({
    key: "RUBINTV_CONTROL_AOS_PIPELINE",
    value: "TIE",
  });
  // The list closes, and the box itself confirms what was sent, and when.
  expect(within(box).queryByRole("menu")).toBeNull();
  const msg = await statusIn("AOS Pipeline");
  expect(msg.textContent).toMatch(stamped("Sent TIE"));
  expect(msg.className).toContain("ok");
});

test("a menu's list closes on Escape or a click elsewhere, sending nothing", async () => {
  stub();
  renderAdmin(createQueryClient());
  const box = await boxFor("AOS Pipeline");
  const trigger = within(box).getByRole("button", { name: /Send a value/ });

  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(within(box).queryByRole("menu")).toBeNull());

  fireEvent.click(trigger);
  expect(within(box).getByRole("menu")).toBeDefined();
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(within(box).queryByRole("menu")).toBeNull());
  // A second click on the trigger closes it too.
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(within(box).queryByRole("menu")).toBeNull();

  expect(posts).toHaveLength(0);
});

test("a menu's list ticks the value the readback says is current", async () => {
  // The analysis side has written "Danish" for the menu's DANISH.
  stub(true, true, {}, { RUBINTV_CONTROL_AOS_PIPELINE_READBACK: "Danish" });
  renderAdmin(createQueryClient());
  await waitFor(async () => expect(await currentIn("AOS Pipeline")).toBe("Danish"));
  const box = await boxFor("AOS Pipeline");
  fireEvent.click(within(box).getByRole("button", { name: /Send a value/ }));
  expect(within(box).getByRole("menuitem", { name: "DANISH" }).className).toContain(
    "current",
  );
  expect(
    within(box).getByRole("menuitem", { name: "TIE" }).className,
  ).not.toContain("current");
});

test("the free-form box writes under the control namespace, as V2 did", async () => {
  stub();
  renderAdmin(createQueryClient());
  const box = await boxFor("Set key / value");
  const send = within(box).getByRole("button", { name: "Send" });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  const typeKey = (value: string) =>
    fireEvent.change(within(box).getByLabelText("control key"), {
      target: { value },
    });

  // Before a key is typed, the line under the inputs shows the prefix that
  // will be added.
  expect(within(box).getByText("Sets RUBINTV_CONTROL_…")).toBeDefined();

  // Whitespace isn't a key, and nor is the prefix alone.
  typeKey("   ");
  expect((send as HTMLButtonElement).disabled).toBe(true);
  expect(within(box).getByText("Sets RUBINTV_CONTROL_…")).toBeDefined();
  typeKey("rubintv_control_");
  expect((send as HTMLButtonElement).disabled).toBe(true);

  // A key typed in full doesn't get the prefix twice (V2 doubled it).
  typeKey("rubintv_control_aos_pipeline");
  expect(
    within(box).getByText("Sets RUBINTV_CONTROL_AOS_PIPELINE"),
  ).toBeDefined();

  // The key is prefixed and uppercased, odd characters becoming _, and the
  // key it will set is shown as it's typed.
  typeKey(" new-thing ");
  expect(within(box).getByText("Sets RUBINTV_CONTROL_NEW_THING")).toBeDefined();
  // The value is uppercased, runs of spaces and underscores collapsing to one.
  fireEvent.change(within(box).getByLabelText("control value"), {
    target: { value: " on  air__now\t" },
  });
  fireEvent.click(send);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].url).toContain("/admin/controls/set");
  expect(posts[0].body).toEqual({
    key: "RUBINTV_CONTROL_NEW_THING",
    value: "ON_AIR_NOW",
  });
  const msg = await statusIn("Set key / value");
  expect(msg.textContent).toMatch(
    stamped("Sent ON_AIR_NOW to RUBINTV_CONTROL_NEW_THING"),
  );
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
  expect((await statusIn("Witness Detector")).textContent).toMatch(
    stamped("Sent R22_S11"),
  );
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
  expect((await statusIn("Reset Head Node")).textContent).toMatch(
    stamped("Reset requested"),
  );

  fireEvent.click(screen.getByRole("button", { name: "Flush historical cache" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Flush cache — confirm/ }),
  );
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1].url).toContain("/admin/flush-historical");
  // Without okText, the server's own detail is shown.
  expect((await statusIn("Flush historical cache")).textContent).toMatch(
    stamped("done"),
  );
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
    await pickIn("AOS Pipeline", "DANISH");
    const msg = await statusIn("AOS Pipeline");
    expect(msg.textContent).toMatch(
      stamped(`Failed — POST /admin/controls/set -> ${why}`),
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
  expect((await statusIn("Flush historical cache")).textContent).toMatch(
    stamped("Failed — TypeError: offline"),
  );
});

test("a reply that says it didn't work reads as a failure", async () => {
  stub();
  // The server answered, but with ok: false and no detail.
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return inner(input, init);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: false, detail: "" }),
    });
  }) as typeof fetch;
  renderAdmin(createQueryClient());
  fireEvent.click(await screen.findByRole("button", { name: "Flush Redis" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Flush Redis — confirm/ }),
  );
  const msg = await statusIn("Flush Redis");
  expect(msg.textContent).toMatch(stamped("Done"));
  expect(msg.className).toContain("err");
});

test("a box shows that a send is under way until the reply comes", async () => {
  stub();
  let answer: (reply: Response) => void = () => {};
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return inner(input, init);
    return new Promise<Response>((resolve) => {
      answer = resolve;
    });
  }) as typeof fetch;
  renderAdmin(createQueryClient());
  await pickIn("AOS Pipeline", "TIE");
  const msg = await statusIn("AOS Pipeline");
  expect(msg.textContent).toBe("Sending…");
  expect(msg.className).toContain("pending");
  await act(async () =>
    answer({
      ok: true,
      json: () => Promise.resolve({ ok: true, detail: "x" }),
    } as Response),
  );
  expect((await statusIn("AOS Pipeline")).textContent).toMatch(stamped("Sent TIE"));
});

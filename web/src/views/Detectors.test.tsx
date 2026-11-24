import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { DISCONNECT_GRACE_MS, LiveProvider } from "../lib/LiveContext";
import { applyLiveMessage } from "../lib/liveQuery";
import { loseLiveConnection, openLiveSockets } from "../test-setup";
import { Detectors } from "./Detectors";

let posts: string[] = [];

// `admin` controls what /admin/status reports for is_admin — the Restart
// controls are hidden unless the user is a site admin — and `user` the login
// it echoes back (null: none reached the app).
function stub({
  admin = true,
  user = "tester",
}: { admin?: boolean; user?: string | null } = {}) {
  posts = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, detail: "restarted" }),
      });
    }
    if (url.includes("/admin/status")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ is_admin: admin, user }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  }) as unknown as typeof fetch;
}

function renderDetectors(qc: ReturnType<typeof createQueryClient>) {
  return render(
    <QueryClientProvider client={qc}>
      <LiveProvider>
        <MemoryRouter>
          <Detectors />
        </MemoryRouter>
      </LiveProvider>
    </QueryClientProvider>,
  );
}

test("renders the Cluster Status layout: heading, legend, sections, queues", async () => {
  stub();
  const qc = createQueryClient();
  renderDetectors(qc);

  expect(await screen.findByRole("heading", { name: "Cluster Status" })).toBeDefined();
  // Legend labels.
  expect(screen.getByText("Free")).toBeDefined();
  expect(screen.getByText("Missing")).toBeDefined();
  // Hardcoded section titles.
  expect(screen.getByText("Imaging Worker Set 1")).toBeDefined();
  expect(screen.getByText("CWFS Worker Set 4")).toBeDefined();
  expect(screen.getByText("SFM Step 1b")).toBeDefined();
  expect(screen.getByText("Backlog Workers")).toBeDefined();
  expect(screen.getByText("Other Queues")).toBeDefined();
});

test("renders queued cell content and the Other Queues table from live data", async () => {
  stub();
  const qc = createQueryClient();
  renderDetectors(qc);
  await screen.findByText("SFM Step 1b");

  act(() =>
    applyLiveMessage(qc, {
      type: "detectorStatus",
      data: {
        detectors: {
          sfmStep1b: {
            workers: {
              "0": { status: "queued", queue_length: 4 },
              "1": { status: "free" },
            },
          },
          otherQueues: { text: { queueA: "12" } },
        },
      },
    }),
  );

  // The queued cell shows its queue length; the Other Queues row appears.
  expect(await screen.findByText("4")).toBeDefined();
  expect(await screen.findByText("queueA")).toBeDefined();
  expect(screen.getByText("12")).toBeDefined();
});

test("a later full snapshot replaces the previous one (no stale sets linger)", async () => {
  // The rebuild's contract is that the backend pushes the *entire* site-wide
  // snapshot on every detectorStatus message (detectors.all()), and the client
  // replaces the cache slot wholesale — there is no per-set merge. This is what
  // immunises it against the v2 bug where successive single-set deltas were
  // shaped differently from the initial snapshot. Assert that a second snapshot
  // both updates a changed set and drops a set that's no longer present.
  stub();
  const qc = createQueryClient();
  renderDetectors(qc);
  await screen.findByText("SFM Step 1b");

  // First snapshot: a queued cell in sfmStep1b and an Other Queues row.
  act(() =>
    applyLiveMessage(qc, {
      type: "detectorStatus",
      data: {
        detectors: {
          sfmStep1b: {
            workers: { "0": { status: "queued", queue_length: 7 } },
          },
          otherQueues: { text: { queueA: "12" } },
        },
      },
    }),
  );
  expect(await screen.findByText("7")).toBeDefined();
  expect(await screen.findByText("queueA")).toBeDefined();

  // Second full snapshot: queue length changes, and otherQueues is gone.
  act(() =>
    applyLiveMessage(qc, {
      type: "detectorStatus",
      data: {
        detectors: {
          sfmStep1b: {
            workers: { "0": { status: "queued", queue_length: 3 } },
          },
        },
      },
    }),
  );

  // The changed value shows; the stale ones are gone (wholesale replace).
  expect(await screen.findByText("3")).toBeDefined();
  await waitFor(() => expect(screen.queryByText("7")).toBeNull());
  expect(screen.queryByText("queueA")).toBeNull();
});

test("restart requires a confirm click, then POSTs the set's restart", async () => {
  stub();
  const qc = createQueryClient();
  renderDetectors(qc);
  await screen.findByText("Imaging Worker Set 1");

  // First Restart Workers button (Imaging Worker Set 1 -> sfmSet0). The buttons
  // appear once /admin/status resolves is_admin=true, so wait for them.
  const buttons = await screen.findAllByRole("button", { name: "Restart Workers" });
  buttons[0].click(); // arms confirm
  expect(posts.length).toBe(0);

  const confirm = await screen.findAllByRole("button", { name: /Confirm restart/ });
  confirm[0].click();
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0]).toContain("/api/detectors/sfmSet0/restart");
});

test("non-admins get no restart controls (server-gated action is hidden)", async () => {
  stub({ admin: false, user: "bob" });
  const qc = createQueryClient();
  renderDetectors(qc);
  // The page renders fully; only the admin-only Restart buttons are absent,
  // and a note says why.
  await screen.findByText("Imaging Worker Set 1");
  expect(
    (await screen.findByRole("note")).textContent,
  ).toBe(
    "Signed in as bob, who isn't an admin for this site, so the worker restart buttons are hidden.",
  );
  expect(screen.queryByRole("button", { name: "Restart Workers" })).toBeNull();
});

test("with no login, the note blames the deployment, not the admin list", async () => {
  stub({ admin: false, user: null });
  const qc = createQueryClient();
  renderDetectors(qc);
  expect((await screen.findByRole("note")).textContent).toMatch(
    /^No login reached the app, so the worker restart buttons are hidden\./,
  );
});

test("admins see no access note", async () => {
  stub();
  const qc = createQueryClient();
  renderDetectors(qc);
  await screen.findAllByRole("button", { name: "Restart Workers" });
  expect(screen.queryByRole("note")).toBeNull();
});

const SET1 = "Imaging Worker Set 1";
const snapshot = (detectors: Record<string, unknown>) => ({
  type: "detectorStatus",
  data: { detectors },
});

test("a set reporting a worker count shows that many cells", async () => {
  stub();
  const qc = createQueryClient();
  renderDetectors(qc);
  const title = await screen.findByText("SFM Step 1b");
  const cells = () =>
    [
      ...title.closest(".step1b-section")!.querySelectorAll(".detector-cell"),
    ].map((c) =>
      c.className.replace("detector-cell ", ""),
    );
  // Before any report: the configured fallback of 8, all missing.
  expect(cells()).toHaveLength(8);

  // 10 advertised, one with detail: the rest are placeholders.
  act(() =>
    applyLiveMessage(
      qc,
      snapshot({ sfmStep1b: { numWorkers: 10, workers: { "0": { status: "busy" } } } }),
    ),
  );
  await waitFor(() => expect(cells()).toHaveLength(10));
  expect(cells()[0]).toBe("status-busy");
  expect(new Set(cells().slice(1))).toEqual(new Set(["status-missing"]));
});

test("a refused restart says why", async () => {
  stub();
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ detail: "site admins only" }),
        })
      : inner(input, init)) as unknown as typeof fetch;
  renderDetectors(createQueryClient());
  (await screen.findAllByRole("button", { name: "Restart Workers" }))[0].click();
  (await screen.findAllByRole("button", { name: /Confirm restart/ }))[0].click();
  const msg = await screen.findByRole("status");
  expect(msg.textContent).toBe(
    `${SET1} restart failed — POST /detectors/sfmSet0/restart -> site admins only`,
  );
  expect(msg.className).toContain("err");
});

describe("the focal-plane canvas", () => {
  // jsdom has neither layout nor a 2D context: give the canvas container a
  // width (delivered through a ResizeObserver that fires on observe, as a
  // browser's does) and record what each canvas draws.
  interface Drawn {
    fills: string[];
    texts: Array<[string, number, number]>;
  }
  const drawn = new Map<HTMLCanvasElement, Drawn>();
  const realRO = globalThis.ResizeObserver;
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  const realRect = HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    drawn.clear();
    globalThis.ResizeObserver = class {
      constructor(private cb: () => void) {}
      observe() {
        this.cb();
      }
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { width: 400 } as DOMRect;
    };
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      const rec: Drawn = { fills: [], texts: [] };
      drawn.set(this, rec);
      const ctx = {
        fillStyle: "",
        scale() {},
        clearRect() {
          rec.fills = [];
          rec.texts = [];
        },
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        stroke() {},
        fill() {
          rec.fills.push(ctx.fillStyle);
        },
        fillText(t: string, x: number, y: number) {
          rec.texts.push([t, x, y]);
        },
      };
      return ctx;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    globalThis.ResizeObserver = realRO;
    HTMLCanvasElement.prototype.getContext = realGetContext;
    HTMLElement.prototype.getBoundingClientRect = realRect;
  });

  test("colours each detector by its worker's state and labels queues", async () => {
    stub();
    const qc = createQueryClient();
    renderDetectors(qc);
    const section = (await screen.findByText(SET1)).closest(
      ".detector-section",
    )!;
    const canvas = section.querySelector("canvas")!;

    act(() =>
      applyLiveMessage(
        qc,
        snapshot({
          sfmSet0: {
            workers: {
              "0": { status: "queued", queue_length: 3 },
              "1": { status: "busy" },
              "2": { status: "queued" }, // no length: nothing to label
            },
          },
        }),
      ),
    );

    await waitFor(() => expect(drawn.get(canvas)?.fills[0]).toBe("#ef4444"));
    const { fills, texts } = drawn.get(canvas)!;
    // All 189 detectors are drawn; unreported ones read as missing.
    expect(fills).toHaveLength(189);
    expect(fills.slice(0, 3)).toEqual(["#ef4444", "#eab308", "#ef4444"]);
    expect(new Set(fills.slice(3))).toEqual(new Set(["#d1d5db"]));
    // Only the queue with a length is labelled, inside the canvas.
    expect(texts).toHaveLength(1);
    const [label, x, y] = texts[0];
    expect(label).toBe("3");
    for (const v of [x, y]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(400);
    }
  });
});

// The cluster writes a set only when it changes and the page keeps the last
// picture it was sent, so a frozen one used to look just like a live one.
// Each message now says whether the server is reading Redis and how long ago
// each set was written.
const READING = {
  configured: true,
  connected: true,
  changed_age_seconds: 3600,
  read_age_seconds: 2,
};
const BUSY = { sfmSet0: { workers: { "0": { status: "busy" } } } };
const AWAITING = "Awaiting cluster status.";

const fresh = (
  redis: Record<string, unknown> | undefined,
  detectors: Record<string, unknown> = {},
  ages: Record<string, number> = {},
) => ({ type: "detectorStatus", data: { detectors, ages, redis } });

function openPage() {
  stub();
  const qc = createQueryClient();
  const view = renderDetectors(qc);
  return {
    send: (frame: ReturnType<typeof fresh>) =>
      act(() => applyLiveMessage(qc, frame)),
    section: () => view.container.querySelector("section")!,
  };
}

describe("how fresh the picture is", () => {
  // The tab's clock stands still (and its one-second ticks are stepped by
  // hand), so every age below is exact however long a run takes.
  const NOW = Date.UTC(2026, 10, 24, 14, 5, 0);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const head = (title: string) =>
    screen.getByText(title).closest(".detector-head") as HTMLElement;

  test("before the first message it only waits", async () => {
    openPage();
    expect(await screen.findByText(AWAITING)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a deployment with no Redis says so", async () => {
    const { send } = openPage();
    await screen.findByText(AWAITING);
    send(
      fresh({
        configured: false,
        connected: false,
        changed_age_seconds: null,
        read_age_seconds: null,
      }),
    );
    expect(
      await screen.findByText(/Redis, which is not configured/),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a Redis with nothing written yet is told from one that isn't answering", async () => {
    const { send, section } = openPage();
    await screen.findByText(AWAITING);
    send(fresh(READING));
    expect(
      await screen.findByText(/Redis is answering, but holds none yet/),
    ).toBeDefined();

    // Down since the server started: nothing to show, and it says why.
    send(
      fresh({
        configured: true,
        connected: false,
        changed_age_seconds: 200,
        read_age_seconds: null,
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "The server has had no answer from Redis since the server started, so there is no cluster status to show. It keeps trying.",
    );
    expect(alert.parentElement!.textContent).toContain("(3 min)");
    // Nothing is drawn back: there is no picture to mistake for a live one.
    expect(section().className).toBe("cluster-status");
  });

  test("shows when the cluster last changed, and each set's own age", async () => {
    const { send, section } = openPage();
    await screen.findByText(AWAITING);
    send(
      fresh(
        READING,
        { ...BUSY, otherQueues: { text: { queueA: "12" } } },
        { sfmSet0: 45, otherQueues: 3 * 3600 },
      ),
    );
    // The newest of them, as a time on this tab's clock.
    expect(
      await screen.findByText("Last change 14:04:15 UTC (45 s ago)"),
    ).toBeDefined();
    expect(
      within(head("Imaging Worker Set 1")).getByText("45 s ago"),
    ).toBeDefined();
    const queues = within(head("Other Queues")).getByText("3 h ago");
    expect(queues.title).toBe(
      "Last written at 11:05:00 UTC. A set is written only when it changes.",
    );
    // A set the message gave no age for shows none.
    expect(head("Imaging Worker Set 2").textContent).toBe(
      "Imaging Worker Set 2",
    );
    expect(section().className).toBe("cluster-status");
    expect(screen.queryByRole("alert")).toBeNull();

    // The ages grow on the tab's own clock, between messages.
    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(
      screen.getByText("Last change 14:04:15 UTC (2 min ago)"),
    ).toBeDefined();
    expect(
      within(head("Imaging Worker Set 1")).getByText("2 min ago"),
    ).toBeDefined();
  });

  test("a set written days ago carries its date", async () => {
    const { send } = openPage();
    await screen.findByText(AWAITING);
    send(fresh(READING, BUSY, { sfmSet0: 3 * 86400 + 300 }));
    expect(
      await screen.findByText("Last change 2026-11-21 14:00:00 UTC (3 d ago)"),
    ).toBeDefined();
  });

  test("sets with no time known show no age at all", async () => {
    const { send } = openPage();
    await screen.findByText(AWAITING);
    send(fresh(READING, BUSY));
    await waitFor(() => expect(screen.queryByText(/Awaiting/)).toBeNull());
    expect(screen.queryByText(/Last change/)).toBeNull();
    expect(screen.queryByText(/ago$/)).toBeNull();
  });

  test("when the server loses Redis the picture is drawn back and dated", async () => {
    const { send, section } = openPage();
    await screen.findByText(AWAITING);
    send(fresh(READING, BUSY, { sfmSet0: 600 }));
    await screen.findByText(/^Last change/);
    expect(section().className).toBe("cluster-status");

    send(
      fresh(
        {
          configured: true,
          connected: false,
          changed_age_seconds: 170,
          read_age_seconds: 180,
        },
        BUSY,
        { sfmSet0: 780 },
      ),
    );
    const alert = await screen.findByRole("alert");
    const said =
      "The server has had no answer from Redis since 14:02:00 UTC, so the picture below is the cluster as it was then. It keeps trying.";
    expect(alert.textContent).toBe(said);
    expect(section().className).toBe("cluster-status is-frozen");
    // The age grows beside the sentence, outside the live region, which
    // holds still.
    expect(alert.parentElement!.textContent).toBe(`${said} (3 min)`);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByRole("alert").textContent).toBe(said);
    expect(alert.parentElement!.textContent).toBe(`${said} (5 min)`);

    // Back: the picture is live again.
    send(fresh(READING, BUSY, { sfmSet0: 900 }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(section().className).toBe("cluster-status");
  });

  test("a message from a server that doesn't report on Redis changes nothing", async () => {
    const { send, section } = openPage();
    await screen.findByText(AWAITING);
    send(
      fresh(
        {
          configured: true,
          connected: false,
          changed_age_seconds: 10,
          read_age_seconds: null,
        },
        BUSY,
      ),
    );
    await screen.findByRole("alert");
    send(fresh(undefined, BUSY));
    send(fresh(READING));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(section().className).toBe("cluster-status");
  });
});

describe("a tab that has lost the server", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  test("says the picture isn't being updated, whatever Redis was doing", async () => {
    const { send, section } = openPage();
    act(() => openLiveSockets());
    await screen.findByText(AWAITING);
    send(fresh(READING, BUSY, { sfmSet0: 5 }));
    await screen.findByText(/^Last change/);

    loseLiveConnection(DISCONNECT_GRACE_MS + 1);
    expect(section().className).toBe("cluster-status is-frozen");
    expect(screen.getByRole("alert").textContent).toMatch(
      /lost its connection to the server/,
    );
    expect(screen.queryByText(/^Last change/)).toBeNull();
  });

  test("with nothing on the page yet there is nothing to qualify", async () => {
    const { section } = openPage();
    act(() => openLiveSockets());
    await screen.findByText(AWAITING);
    loseLiveConnection(DISCONNECT_GRACE_MS + 1);
    expect(screen.getByText(AWAITING)).toBeDefined();
    expect(section().className).toBe("cluster-status");
  });
});

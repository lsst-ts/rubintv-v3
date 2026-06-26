import { render, screen, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { applyLiveMessage } from "../lib/liveQuery";
import { Detectors } from "./Detectors";

let posts: string[] = [];

function stub() {
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

  // First Restart Workers button (Imaging Worker Set 1 -> sfmSet0).
  const buttons = screen.getAllByRole("button", { name: "Restart Workers" });
  buttons[0].click(); // arms confirm
  expect(posts.length).toBe(0);

  const confirm = await screen.findAllByRole("button", { name: /Restart — confirm/ });
  confirm[0].click();
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0]).toContain("/api/detectors/sfmSet0/restart");
});

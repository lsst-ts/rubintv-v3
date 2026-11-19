import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveProvider } from "./LiveContext";
import { applyLiveMessage } from "./liveQuery";
import {
  applyChanges,
  metadataKey,
  metadataRewritten,
  type MetadataDoc,
} from "./metadata";
import { useMetadata } from "./useMetadata";
import {
  dropLiveSocket,
  openLiveSockets,
  pushLiveMessage,
} from "../test-setup";

const AT = ["local", "lsstcam", "2026-04-10"] as const;
const FRAME = { location: AT[0], camera: AT[1], date: AT[2] };

interface Reply {
  etag: string | null;
  since: string | null;
  rows: Record<string, Record<string, unknown>>;
  removed: string[];
}

const whole = (etag: string, rows: Reply["rows"]): Reply => ({
  etag,
  since: null,
  rows,
  removed: [],
});

/** Stand in for the server: answer each `/changes` request in turn with the
 *  next reply, recording the `since` each one asked from. A reply may be a
 *  promise the test resolves later, or an HTTP status to fail with. */
function serve(...replies: (Reply | Promise<Reply> | number)[]) {
  const asked: (string | null)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    expect(url.pathname).toMatch(/\/metadata\/2026-04-10\/changes$/);
    asked.push(url.searchParams.get("since"));
    const reply = replies.shift();
    if (reply === undefined) throw new Error("no reply left to serve");
    if (typeof reply === "number") return { ok: false, status: reply };
    return { ok: true, json: async () => reply };
  }) as unknown as typeof fetch;
  return asked;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function mount(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <LiveProvider>{children}</LiveProvider>
    </QueryClientProvider>
  );
  return { qc, ...renderHook(() => useMetadata(...AT), { wrapper }) };
}

test("a whole document replaces what was held; a difference is applied to it", () => {
  const v1 = applyChanges(undefined, whole('"v1"', { "1": { a: 1 }, "2": { a: 2 } }));
  expect(v1).toEqual({ etag: '"v1"', rows: { "1": { a: 1 }, "2": { a: 2 } } });

  const v2 = applyChanges(v1, {
    etag: '"v2"',
    since: '"v1"',
    rows: { "2": { a: 20 }, "3": { a: 3 } },
    removed: ["1"],
  });
  expect(v2).toEqual({ etag: '"v2"', rows: { "2": { a: 20 }, "3": { a: 3 } } });
  // The held document is never altered in place: React saw it as it was.
  expect(v1.rows).toEqual({ "1": { a: 1 }, "2": { a: 2 } });

  // A whole document drops rows the server no longer has, not merges them.
  expect(applyChanges(v2, whole('"v3"', { "9": { a: 9 } })).rows).toEqual({
    "9": { a: 9 },
  });
});

test("an unchanged version is the same object, so nothing re-renders", () => {
  const held: MetadataDoc = { etag: '"v1"', rows: { "1": { a: 1 } } };
  const unchanged = { etag: '"v1"', since: '"v1"', rows: {}, removed: [] };
  expect(applyChanges(held, unchanged)).toBe(held);
  // A date with no metadata.json has no version, each time it is asked.
  const none: MetadataDoc = { etag: null, rows: {} };
  expect(applyChanges(none, { ...unchanged, etag: null, since: null })).toBe(none);
});

test("the hook reports loading, then the rows", async () => {
  const reply = deferred<Reply>();
  const asked = serve(reply.promise);
  const { result, rerender } = mount();
  expect(result.current).toEqual({
    metadata: {},
    loaded: false,
    loading: true,
    failed: false,
  });
  // The same empty object each render, so consumers' memos hold.
  const empty = result.current.metadata;
  rerender();
  expect(result.current.metadata).toBe(empty);
  reply.resolve(whole('"v1"', { "1": { Exposure: 30 } }));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current).toEqual({
    metadata: { "1": { Exposure: 30 } },
    loaded: true,
    loading: false,
    failed: false,
  });
  // A page holding nothing asks for the whole document.
  expect(asked[0]).toBeNull();
});

test("a failed fetch is reported, not shown as a night without metadata", async () => {
  serve(503);
  const { result } = mount();
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.loaded).toBe(false);
  expect(result.current.loading).toBe(false);
});

test("a failed refresh keeps the rows already shown", async () => {
  const asked = serve(whole('"v1"', { "1": { Exposure: 30 } }), 503);
  const { result, qc } = mount();
  await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => pushLiveMessage({ type: "metadata", ...FRAME }));
  // The refetch fails; nothing on the page should change for it.
  await waitFor(() => expect(asked).toHaveLength(2));
  await waitFor(() => expect(qc.isFetching()).toBe(0));
  expect(result.current.metadata).toEqual({ "1": { Exposure: 30 } });
  expect(result.current.failed).toBe(false);
});

test("a rewrite fetches the difference from the version held", async () => {
  const asked = serve(whole('"v1"', { "1": { Exposure: 30 }, "2": { Exposure: 15 } }), {
    etag: '"v2"',
    since: '"v1"',
    rows: { "3": { Exposure: 5 } },
    removed: ["1"],
  });
  const { result } = mount();
  await waitFor(() => expect(result.current.loaded).toBe(true));
  const row2 = result.current.metadata["2"];

  act(() => pushLiveMessage({ type: "metadata", ...FRAME }));
  await waitFor(() =>
    expect(result.current.metadata).toEqual({
      "2": { Exposure: 15 },
      "3": { Exposure: 5 },
    }),
  );
  expect(asked).toEqual([null, '"v1"']);
  // An untouched row is the same object: its cells needn't re-render.
  expect(result.current.metadata["2"]).toBe(row2);
});

test("a rewrite of another date, or one no view shows, fetches nothing", async () => {
  const asked = serve(whole('"v1"', {}));
  const { result, qc } = mount();
  await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => {
    pushLiveMessage({ type: "metadata", ...FRAME, date: "2026-04-09" });
    pushLiveMessage({ type: "metadata", ...FRAME, camera: "auxtel" });
    // Without a date there is nothing to name.
    applyLiveMessage(qc, { type: "metadata", location: AT[0], camera: AT[1] });
  });
  // A fetch would have begun, and been counted, as its message was applied.
  expect(qc.isFetching()).toBe(0);
  expect(asked).toHaveLength(1);
});

test("rows that arrive after a dropped socket are not masked by older ones", async () => {
  // With a stream and a REST snapshot merged at render, a snapshot taken
  // while the socket was down overrode every later row for good.
  const asked = serve(
    whole('"v1"', { "1": { Exposure: 30 } }),
    { etag: '"v2"', since: '"v1"', rows: { "1": { Exposure: 31 } }, removed: [] },
    { etag: '"v3"', since: '"v2"', rows: { "1": { Exposure: 32 } }, removed: [] },
  );
  const { result } = mount();
  act(() => openLiveSockets());
  await waitFor(() => expect(result.current.loaded).toBe(true));

  act(() => dropLiveSocket());
  // The reconnect refetches what may have been missed...
  act(() => openLiveSockets());
  await waitFor(() => expect(result.current.metadata["1"]).toEqual({ Exposure: 31 }));
  // ...and a later rewrite still lands.
  act(() => pushLiveMessage({ type: "metadata", ...FRAME }));
  await waitFor(() => expect(result.current.metadata["1"]).toEqual({ Exposure: 32 }));
  expect(asked).toEqual([null, '"v1"', '"v2"']);
});

test("a rewrite during a fetch doesn't restart it, but is asked about after", async () => {
  // A whole document over a slow link can take longer than the gap between
  // rewrites. Restarted on each one, it never finished.
  const first = deferred<Reply>();
  const asked = serve(first.promise, {
    etag: '"v2"',
    since: '"v1"',
    rows: { "2": { Exposure: 15 } },
    removed: [],
  });
  const { result } = mount();
  await waitFor(() => expect(asked).toHaveLength(1));
  act(() => {
    pushLiveMessage({ type: "metadata", ...FRAME });
    pushLiveMessage({ type: "metadata", ...FRAME });
  });
  expect(asked).toHaveLength(1);

  first.resolve(whole('"v1"', { "1": { Exposure: 30 } }));
  await waitFor(() =>
    expect(result.current.metadata).toEqual({
      "1": { Exposure: 30 },
      "2": { Exposure: 15 },
    }),
  );
  // One follow-up for both rewrites, from the version just received.
  expect(asked).toEqual([null, '"v1"']);
});

test("a fetch overtaken again and again gives up and shows what it has", async () => {
  const qc = new QueryClient();
  const asked: (string | null)[] = [];
  let version = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(new URL(String(input), "http://x").searchParams.get("since"));
    // Every answer is overtaken by another rewrite before it lands.
    metadataRewritten(qc, ...AT);
    version += 1;
    return {
      ok: true,
      json: async () => whole(`"v${version}"`, { "1": { Exposure: version } }),
    };
  }) as unknown as typeof fetch;
  const { result } = mount(qc);
  await waitFor(() => expect(result.current.loaded).toBe(true));
  // The first try and three more, then the rows it ended with.
  expect(asked).toHaveLength(4);
  expect(result.current.metadata).toEqual({ "1": { Exposure: 4 } });
  expect(qc.getQueryData<MetadataDoc>(metadataKey(...AT))?.etag).toBe('"v4"');
});

test("without a date there is nothing to fetch", () => {
  const asked = serve();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <LiveProvider>{children}</LiveProvider>
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useMetadata("local", "lsstcam", ""), {
    wrapper,
  });
  expect(result.current).toEqual({
    metadata: {},
    loaded: false,
    loading: false,
    failed: false,
  });
  expect(asked).toEqual([]);
});

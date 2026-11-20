import { act, render, renderHook, screen } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ConnectionStatus } from "../components/ConnectionStatus";
import {
  dropLiveSocket,
  liveSockets,
  pushLiveMessage,
  pushRawLiveFrame,
} from "../test-setup";
import { BASE } from "./basePath";
import { DISCONNECT_GRACE_MS, LiveProvider } from "./LiveContext";
import { createQueryClient } from "./queryClient";
import { SILENCE_LIMIT_MS, useWebSocket } from "./ws";

// The tab's one live connection: it reports its state, reconnects with
// backoff after a drop, replays its subscriptions on the new socket, and asks
// for a refetch of whatever was missed while it was down.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Open only the newest socket — older ones are dead connections.
const openNewest = () => act(() => liveSockets().at(-1)!.onopen?.());
const drop = () => act(() => dropLiveSocket());
const sentOn = (i: number) => liveSockets()[i].sent;
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

test("the status pill follows the connection through a drop and back", () => {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <ConnectionStatus verbose />
      </LiveProvider>
    </QueryClientProvider>,
  );
  const pill = screen.getByRole("status");
  expect(pill.textContent).toBe("WebSocket connecting…");
  expect(pill.getAttribute("title")).toMatch(/trying to open/);

  openNewest();
  expect(pill.textContent).toBe("WebSocket connected");
  expect(pill.className).toContain("conn-open");
  expect(pill.getAttribute("title")).toMatch(/arrive automatically/);

  drop();
  expect(pill.textContent).toBe("WebSocket disconnected");
  expect(pill.getAttribute("title")).toMatch(/won't update/);

  // The first retry comes half a second later, on a new socket.
  act(() => vi.advanceTimersByTime(500));
  expect(liveSockets()).toHaveLength(2);
  expect(pill.textContent).toBe("WebSocket connecting…");
  openNewest();
  expect(pill.textContent).toBe("WebSocket connected");
});

test("the header's notice shows only once the connection has been down a while", () => {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <ConnectionStatus />
      </LiveProvider>
    </QueryClientProvider>,
  );
  const notice = () => screen.queryByRole("status");
  // The first connect, and a drop the retry recovers from, pass unremarked.
  expect(notice()).toBeNull();
  openNewest();
  drop();
  wait(500);
  openNewest();
  wait(DISCONNECT_GRACE_MS);
  expect(notice()).toBeNull();

  // A connection that stays down through its retries is reported...
  drop();
  wait(DISCONNECT_GRACE_MS - 1);
  expect(notice()).toBeNull();
  wait(1);
  expect(notice()!.textContent).toBe("Disconnected");
  expect(notice()!.getAttribute("title")).toMatch(/not arriving/);
  // ...until it is back.
  openNewest();
  expect(notice()).toBeNull();
});

test("a page whose first connect never succeeds says so too", () => {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <ConnectionStatus />
      </LiveProvider>
    </QueryClientProvider>,
  );
  wait(DISCONNECT_GRACE_MS);
  expect(screen.getByRole("status").textContent).toBe("Disconnected");
});

test("the socket connects to the app's /ws on the page's host", () => {
  renderHook(() => useWebSocket());
  expect(liveSockets()[0].url).toBe(`ws://${window.location.host}${BASE}/ws`);
});

test("retries back off, doubling to a cap, and reset once connected", () => {
  renderHook(() => useWebSocket());
  const delays: number[] = [];
  // Drop each attempt and measure how long the next one takes to start.
  for (let i = 0; i < 6; i++) {
    const before = liveSockets().length;
    drop();
    let waited = 0;
    while (liveSockets().length === before) {
      act(() => vi.advanceTimersByTime(250));
      waited += 250;
    }
    delays.push(waited);
  }
  expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10000]);

  // A successful open resets the ladder.
  openNewest();
  const before = liveSockets().length;
  drop();
  act(() => vi.advanceTimersByTime(500));
  expect(liveSockets()).toHaveLength(before + 1);
});

test("a waiting retry can be brought forward, and nothing else can", () => {
  const { result, unmount } = renderHook(() => useWebSocket());
  // A try under way, then an open socket: nothing to hurry.
  act(() => result.current.retryNow());
  openNewest();
  act(() => result.current.retryNow());
  expect(liveSockets()).toHaveLength(1);

  // Down long enough for the retries to thin out to one every 10 s.
  for (let i = 0; i < 6; i++) {
    drop();
    wait(10_000);
  }
  drop();
  const before = liveSockets().length;
  wait(1000);
  expect(liveSockets()).toHaveLength(before);
  act(() => result.current.retryNow());
  expect(liveSockets()).toHaveLength(before + 1);
  // The retry it replaced doesn't also fire.
  wait(10_000);
  expect(liveSockets()).toHaveLength(before + 1);

  // A try that fails goes back to waiting, at the delay it had reached.
  drop();
  wait(9750);
  expect(liveSockets()).toHaveLength(before + 1);
  wait(250);
  expect(liveSockets()).toHaveLength(before + 2);

  // Nor after the tab has gone.
  drop();
  unmount();
  act(() => result.current.retryNow());
  expect(liveSockets()).toHaveLength(before + 2);
});

test("a reconnect replays each held topic once and asks for a refetch", () => {
  const onReconnect = vi.fn();
  const { result } = renderHook(() => useWebSocket(undefined, { onReconnect }));
  openNewest();
  expect(onReconnect).not.toHaveBeenCalled(); // the first open isn't a reconnect

  // Two consumers of one topic, one of another.
  const sub = { topic: "camera", location: "summit", camera: "lsstcam" };
  act(() => {
    result.current.subscribe(sub);
    result.current.subscribe(sub);
    result.current.subscribe({ topic: "detectors" });
  });

  drop();
  act(() => vi.advanceTimersByTime(500));
  openNewest();
  expect(onReconnect).toHaveBeenCalledTimes(1);
  expect(sentOn(1)).toEqual([
    { action: "subscribe", ...sub },
    { action: "subscribe", topic: "detectors" },
  ]);
});

test("a subscription is released once its last holder lets go", () => {
  const { result } = renderHook(() => useWebSocket());
  openNewest();
  const sub = { topic: "detectors" };
  let a = () => {};
  let b = () => {};
  act(() => {
    a = result.current.subscribe(sub);
    b = result.current.subscribe(sub);
  });
  expect(sentOn(0)).toEqual([{ action: "subscribe", topic: "detectors" }]);

  act(() => a());
  act(() => a()); // a second release by the same holder is a no-op
  expect(sentOn(0)).toHaveLength(1);
  act(() => b());
  expect(sentOn(0).at(-1)).toEqual({ action: "unsubscribe", topic: "detectors" });
});

test("a non-JSON frame is skipped and later frames still arrive", () => {
  const { result } = renderHook(() => useWebSocket());
  const seen: unknown[] = [];
  act(() => {
    result.current.onMessage((m) => seen.push(m));
  });
  act(() => {
    pushRawLiveFrame("not json");
    pushLiveMessage({ type: "channelData", camera: "c", data: { 1: {} } });
    pushLiveMessage({ type: "metadata", camera: "c" });
  });
  expect(seen).toEqual([
    { type: "channelData", camera: "c", data: { 1: {} } },
    { type: "metadata", camera: "c" },
  ]);
});

test("a socket that goes silent is given up on and replaced", () => {
  // The server sends a heartbeat on a quiet connection, so silence means the
  // socket died without closing; the browser may not notice for minutes.
  const onReconnect = vi.fn();
  const { result } = renderHook(() => useWebSocket(undefined, { onReconnect }));
  const seen: unknown[] = [];
  act(() => {
    result.current.onMessage((m) => seen.push(m));
  });
  openNewest();

  // Heartbeats keep it alive, and are not passed on to the views.
  wait(SILENCE_LIMIT_MS - 1);
  act(() => pushLiveMessage({ type: "heartbeat" }));
  wait(SILENCE_LIMIT_MS - 1);
  expect(result.current.status).toBe("open");
  expect(seen).toEqual([]);

  // Then nothing: the socket is closed and a new one tried.
  wait(1);
  expect(result.current.status).toBe("closed");
  expect(liveSockets()[0].closed).toBe(true);
  wait(500);
  expect(liveSockets()).toHaveLength(2);
  openNewest();
  expect(onReconnect).toHaveBeenCalledTimes(1);

  // The abandoned socket's own close, and a frame it had in flight, start no
  // second retry and don't keep its replacement alive.
  act(() => liveSockets()[0].onclose?.());
  wait(SILENCE_LIMIT_MS - 1);
  act(() => liveSockets()[0].onmessage?.({ data: '{"type":"heartbeat"}' }));
  expect(liveSockets()).toHaveLength(2);
  wait(1);
  expect(liveSockets()[1].closed).toBe(true);
});

test("a connect that hangs is given up on like a silent socket", () => {
  renderHook(() => useWebSocket());
  wait(SILENCE_LIMIT_MS);
  expect(liveSockets()[0].closed).toBe(true);
  wait(500);
  expect(liveSockets()).toHaveLength(2);
});

test("a tab opened during an outage asks for a refetch when it first connects", () => {
  // Its first requests failed with the connect, and nothing else would make
  // them again; a first connect that just works has nothing to make up.
  const onReconnect = vi.fn();
  renderHook(() => useWebSocket(undefined, { onReconnect }));
  drop();
  act(() => vi.advanceTimersByTime(500));
  openNewest();
  expect(onReconnect).toHaveBeenCalledTimes(1);
});

test("unmounting closes the socket and cancels a pending retry", () => {
  const { unmount } = renderHook(() => useWebSocket());
  drop();
  unmount();
  expect(liveSockets()[0].closed).toBe(true);
  act(() => vi.advanceTimersByTime(20_000));
  expect(liveSockets()).toHaveLength(1);
  // A late close from the abandoned socket schedules nothing either.
  act(() => liveSockets()[0].onclose?.());
  act(() => vi.advanceTimersByTime(20_000));
  expect(liveSockets()).toHaveLength(1);
});

test("a socket that opens after its tab unmounted closes itself", () => {
  const { result, unmount } = renderHook(() => useWebSocket());
  act(() => {
    result.current.subscribe({ topic: "detectors" });
  });
  const sock = liveSockets()[0];
  const sentBefore = sock.sent.length;
  unmount();
  sock.closed = false;
  act(() => sock.onopen?.());
  expect(sock.closed).toBe(true);
  // Nothing is replayed on the abandoned connection.
  expect(sock.sent).toHaveLength(sentBefore);
});

test("after a reconnect the provider refetches the views' data", async () => {
  let fetches = 0;
  globalThis.fetch = (() => {
    fetches += 1;
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  }) as unknown as typeof fetch;
  function View() {
    useQuery({
      queryKey: ["x"],
      queryFn: () => fetch("/api/x").then((r) => r.json()),
    });
    return null;
  }
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <View />
      </LiveProvider>
    </QueryClientProvider>,
  );
  await act(async () => {});
  openNewest();
  await act(async () => {});
  expect(fetches).toBe(1);

  drop();
  act(() => vi.advanceTimersByTime(500));
  openNewest();
  await act(async () => {});
  expect(fetches).toBe(2);
});

test("a status poll that gets through brings the retry forward; other queries don't", async () => {
  // Pages poll the server's status every 5 s, so they hear it is back before
  // a retry that has backed off to every 10 s does.
  globalThis.fetch = (() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({}) })) as unknown as typeof fetch;
  const qc = createQueryClient();
  render(
    <QueryClientProvider client={qc}>
      <LiveProvider>
        <ConnectionStatus verbose />
      </LiveProvider>
    </QueryClientProvider>,
  );
  const load = (key: string) =>
    act(() =>
      qc.fetchQuery({
        queryKey: [key],
        queryFn: () => fetch(`/api/${key}`).then((r) => r.json()),
        staleTime: 0,
      }),
    );
  openNewest();
  for (let i = 0; i < 6; i++) {
    drop();
    wait(10_000);
  }
  drop();
  const before = liveSockets().length;

  await load("locations");
  expect(liveSockets()).toHaveLength(before);
  await load("status");
  expect(liveSockets()).toHaveLength(before + 1);
  openNewest();
  expect(screen.getByRole("status").textContent).toBe("WebSocket connected");

  // Connected again: the poll carries on, and stirs nothing.
  await load("status");
  expect(liveSockets()).toHaveLength(before + 1);
});

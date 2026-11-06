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
import { LiveProvider } from "./LiveContext";
import { createQueryClient } from "./queryClient";
import { useWebSocket } from "./ws";

// The tab's one live connection: it reports its state, reconnects with
// backoff after a drop, replays its subscriptions on the new socket, and asks
// for a refetch of whatever was missed while it was down.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Open only the newest socket — older ones are dead connections.
const openNewest = () => act(() => liveSockets().at(-1)!.onopen?.());
const drop = () => act(() => dropLiveSocket());
const sentOn = (i: number) => liveSockets()[i].sent;

test("the status pill follows the connection through a drop and back", () => {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <ConnectionStatus />
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
    pushLiveMessage({ type: "metadataChunk", camera: "c", data: { 1: {} } });
    pushLiveMessage({ type: "metadataComplete", camera: "c" });
  });
  expect(seen).toEqual([
    { type: "metadataChunk", camera: "c", data: { 1: {} } },
    { type: "metadataComplete", camera: "c" },
  ]);
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

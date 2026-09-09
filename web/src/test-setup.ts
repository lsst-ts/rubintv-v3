// Vitest setup. Stub WebSocket so components that open the per-tab socket
// (e.g. ConnectionStatus) don't try a real network connection in jsdom.
//
// By default the stub stays quiet — it never fires `onopen`, matching the
// prior behaviour every existing test was written against (a socket that
// constructs but never connects). Live-update tests opt in via
// openLiveSockets(), which flips the connection to open so the view's queued
// subscribe frames flush; the stub records those frames and can push a server
// frame back through `onmessage`.
class StubWebSocket {
  static OPEN = 1;
  // Every socket opened during a test, newest last. Cleared between tests.
  static instances: StubWebSocket[] = [];
  readyState = StubWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  // Frames the view sent us (subscribe/unsubscribe), for assertions.
  sent: unknown[] = [];

  constructor() {
    StubWebSocket.instances.push(this);
  }

  send(data: string) {
    try {
      this.sent.push(JSON.parse(data));
    } catch {
      this.sent.push(data);
    }
  }
  close() {}
}

// Open every socket this test has constructed, firing `onopen` so the view's
// queued subscribe frames flush and the connection reports "open". Opt-in so
// the default (never-connects) behaviour the rest of the suite relies on is
// untouched. Call inside act()/waitFor since it triggers a state update.
export function openLiveSockets(): void {
  for (const sock of StubWebSocket.instances) sock.onopen?.();
}

// Deliver a server frame to every socket (tests run one tab, so this is the
// single live connection). Mirrors the wire format: a JSON-encoded frame
// passed to `onmessage`, exactly as the real socket receives it.
export function pushLiveMessage(frame: unknown): void {
  const json = JSON.stringify(frame);
  for (const sock of StubWebSocket.instances) {
    sock.onmessage?.({ data: json });
  }
}

// Drop sockets from prior tests so each test sees only its own connection.
export function resetLiveSockets(): void {
  StubWebSocket.instances = [];
}

// Frames the app sent over its socket(s) this test (subscribe / unsubscribe),
// in order. Lets a test assert that a view actually subscribed to its topic —
// the thing the server keys streaming off, which a direct pushLiveMessage
// can't stand in for.
export function sentLiveFrames(): unknown[] {
  return StubWebSocket.instances.flatMap((s) => s.sent);
}

// @ts-expect-error - assigning a stub over the DOM global for tests.
globalThis.WebSocket = StubWebSocket;

// Each test gets a fresh socket registry so pushLiveMessage only reaches the
// connection opened by the current render.
beforeEach(resetLiveSockets);

// jsdom implements neither ResizeObserver nor the canvas 2D context. The
// Cluster Status view's canvas uses both; stub them so the component mounts
// (the canvas drawing itself isn't asserted in tests — structure is).
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  StubResizeObserver as unknown as typeof ResizeObserver;

// jsdom gives every element a zero-size layout (no rendering engine), so the
// row virtualizer in the camera table reads offsetHeight 0 for both its scroll
// viewport and its rows, and renders nothing. @tanstack/react-virtual sizes
// from offsetWidth/offsetHeight, so report a tall, fixed viewport for the
// scroll container and a stable per-row height; the virtualizer then
// materializes rows the tests assert on. (In a browser these come from layout.)
const VIEWPORT_H = 2000;
const ROW_H = 36;
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList?.contains("table-wrap")) return VIEWPORT_H;
    if (this.tagName === "TR") return ROW_H;
    return 0;
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return 0;
  },
});

if (!HTMLCanvasElement.prototype.getContext) {
  // Minimal stub: the canvas view bails out when getContext returns null.
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
}

// jsdom has no matchMedia; the theme toggle queries prefers-color-scheme.
// Stub it as "light, no preference" with no-op listeners.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;
}

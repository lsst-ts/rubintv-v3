// Vitest setup. Stub WebSocket so components that open the per-tab socket
// (e.g. ConnectionStatus) don't try a real network connection in jsdom.
class StubWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  send() {}
  close() {}
}

// @ts-expect-error - assigning a stub over the DOM global for tests.
globalThis.WebSocket = StubWebSocket;

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

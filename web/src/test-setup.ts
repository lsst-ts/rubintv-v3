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

if (!HTMLCanvasElement.prototype.getContext) {
  // Minimal stub: the canvas view bails out when getContext returns null.
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
}

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

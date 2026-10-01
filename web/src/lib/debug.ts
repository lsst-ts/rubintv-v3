// Lightweight opt-in debug logging. Enable in the browser console with:
//   localStorage.setItem("rubintv:debug", "1")  (then reload)
// and disable by removing the key. Off by default so production is quiet.

const ENABLED =
  typeof localStorage !== "undefined" &&
  localStorage.getItem("rubintv:debug") === "1";

export function debugLog(scope: string, ...args: unknown[]): void {
  if (ENABLED) {
    console.debug(`[rubintv:${scope}]`, ...args);
  }
}

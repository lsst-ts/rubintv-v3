import { useLive } from "../lib/LiveContext";

// Live indicator of this tab's WebSocket, read from the shared LiveProvider
// (one connection per tab).
export function ConnectionStatus() {
  const { status } = useLive();
  const label =
    status === "open"
      ? "live"
      : status === "connecting"
        ? "connecting…"
        : "offline";
  // Full wording lives in the title tooltip, matching the compact `.conn`
  // register shared with the S3/scan pills.
  const hint =
    status === "open"
      ? "Live: this tab's WebSocket is connected — new images and metadata arrive automatically as they're published."
      : status === "connecting"
        ? "Connecting: this tab is trying to open its live WebSocket. Updates will resume once it connects."
        : "Offline: this tab's live WebSocket is closed — the page won't update until the connection is restored.";
  return (
    <span className={`conn conn-${status}`} role="status" title={hint}>
      {label}
    </span>
  );
}

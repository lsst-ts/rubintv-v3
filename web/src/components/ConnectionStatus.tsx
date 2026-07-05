import { useLive } from "../lib/LiveContext";

// Status of this tab's live WebSocket, read from the shared LiveProvider (one
// connection per tab). Lives on the Status page, where it reports whether the
// browser↔app-server connection that streams new images and metadata is up.
export function ConnectionStatus() {
  const { status } = useLive();
  const label =
    status === "open"
      ? "WebSocket connected"
      : status === "connecting"
        ? "WebSocket connecting…"
        : "WebSocket disconnected";
  // Full wording lives in the title tooltip, matching the compact `.conn`
  // register shared with the S3/scan pills.
  const hint =
    status === "open"
      ? "This tab's live WebSocket is connected — new images and metadata arrive automatically as they're published."
      : status === "connecting"
        ? "This tab is trying to open its live WebSocket. Updates will resume once it connects."
        : "This tab's live WebSocket is closed — the page won't update until the connection is restored.";
  return (
    <span className={`conn conn-${status}`} role="status" title={hint}>
      {label}
    </span>
  );
}

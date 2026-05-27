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
  return (
    <span className={`conn conn-${status}`} role="status">
      {label}
    </span>
  );
}

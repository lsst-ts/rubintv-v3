import { useWebSocket } from "../lib/ws";

// Live indicator of this tab's WebSocket. One connection per tab, so this
// reflects only this tab's link to the server.
export function ConnectionStatus() {
  const { status } = useWebSocket();
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

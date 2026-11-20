import { useLive } from "../lib/LiveContext";

// Status of this tab's live WebSocket, read from the shared LiveProvider (one
// connection per tab): the browser↔app-server connection that announces new
// images and metadata.
//
// In the header it stays quiet while the connection is up, like the S3 pill,
// and shows only once the socket has been down for longer than a blip — the
// one sign on a data page that it has stopped updating.
//
// `verbose` renders every state (the Status page's WebSocket section), where
// staying quiet would read as "unknown" rather than "fine".
export function ConnectionStatus({ verbose = false }: { verbose?: boolean }) {
  const { status, disconnected } = useLive();
  if (!verbose) {
    if (!disconnected) return null;
    return (
      <span
        className="conn conn-lost"
        role="status"
        title="This tab has lost its live connection to the server, so new images and metadata are not arriving. It keeps trying to reconnect, and catches up when it does."
      >
        Disconnected
      </span>
    );
  }
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

// The header's notice for a page whose header is not on screen: a warning
// triangle (see .conn-mark). A headerless embed has no header at all, so
// there it stands for the notice, pinned to the corner. `inline` is the
// camera table's, which sits in its toolbar beside the UTC clock: the table
// slides the topbar away while scrolled down, so with `scrollHint` it points
// back up to the notice.
export function DisconnectedMark({
  scrollHint = false,
  inline = false,
}: {
  scrollHint?: boolean;
  inline?: boolean;
}) {
  const { disconnected } = useLive();
  if (!disconnected) return null;
  const hint = scrollHint
    ? "Disconnected: this page is not updating. Scroll up to see the header for more."
    : "Disconnected: this view has lost its live connection to the server and is not updating. It keeps trying to reconnect, and catches up when it does.";
  return (
    <span
      className={"conn-mark" + (inline ? " conn-mark--inline" : "")}
      role="img"
      aria-label={hint}
      title={hint}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3.2 1.8 20.8h20.4L12 3.2z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M12 9.5v5.2M12 17.8v.1"
          fill="none"
          stroke="#fff"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

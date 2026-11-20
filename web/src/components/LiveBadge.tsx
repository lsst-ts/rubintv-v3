import { useLive } from "../lib/LiveContext";

// The word for the state of a view that follows the newest data, shown on its
// badge and in the tab's title. It is LIVE only while the tab's connection is
// up: with it down the view still points at the newest frame it knows of, but
// nothing newer will arrive, so it takes the header notice's word instead.
export function useLiveWord(): "LIVE" | "DISCONNECTED" {
  return useLive().disconnected ? "DISCONNECTED" : "LIVE";
}

export function LiveBadge() {
  const word = useLiveWord();
  return word === "LIVE" ? (
    <span className="tag live live-badge" role="status">
      LIVE
    </span>
  ) : (
    <span
      className="tag stalled live-badge"
      role="status"
      title="This tab has lost its live connection to the server, so this view is not following new data. It keeps trying to reconnect, and catches up when it does."
    >
      DISCONNECTED
    </span>
  );
}

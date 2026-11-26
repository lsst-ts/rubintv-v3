import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { utcClock } from "../lib/lastPoll";
import { locationsWhere, pollFor } from "../lib/pollStatus";

// S3-connectivity indicator beside the live (WebSocket) pill. The 'live' pill
// shows the browser↔app-server WS; this shows whether the app server is
// reaching the S3 bucket. It stays quiet when healthy and surfaces three
// escalating states the operator would otherwise only find in the logs:
//   - amber 'S3 slow'        — the last poll cycle was unusually slow, an
//                              early warning of a degrading link;
//   - red   'S3 unreachable' — the last cycle failed to reach S3 outright
//                              (e.g. a botocore connect timeout);
//   - red   'Poll stalled'   — the cycle now running has not finished, so
//                              polling has stopped. The other two describe
//                              the last cycle to finish and would go on
//                              saying what it found, so this comes first.
// 'unreachable' takes precedence over 'slow'.
//
// The server polls each location on its own, so with a `location` the pill
// reports that location's poll alone: a bucket the server can't reach shows
// on its own pages and not on another location's. Without one it reports
// them all: the worst state any is in, how many are in it when that isn't
// all of them ("S3: 1 of 4 unreachable"), and in its tooltip which.
//
// Both are the server's own report, so they are only as fresh as the page's
// last successful status poll. When that poll fails the pill says so (red
// 'Server unreachable') instead of repeating the last answer it got, which
// for a server that has gone away is normally "healthy".
//
// `linkToStatus` makes the pill a link to the Status page (its ops deep-dive:
// per-camera scan state and last-cycle latency). Enabled in the header, where
// the pill is the natural jumping-off point; left off inside the Status page
// itself, where it would link to the current page.
//
// `verbose` renders the healthy state too (a green "S3 connected" pill) for
// contexts that dedicate space to S3 health — the Status page's S3 section —
// where staying quiet would read as "unknown" rather than "fine".
export function S3Status({
  location,
  linkToStatus = false,
  verbose = false,
}: {
  location?: string;
  linkToStatus?: boolean;
  verbose?: boolean;
}) {
  const { data, dataUpdatedAt, isError } = useQuery({
    queryKey: ["status"],
    queryFn: () => api.status(),
    // Always poll: connectivity can drop after loading completes, so unlike
    // the historical-loading banner this never stops watching.
    refetchInterval: 5000,
  });

  // Render the pill, optionally wrapped in a Link to the Status page. The
  // alert/status role and title stay on the visible element so screen readers
  // still announce the severity whether or not it's a link.
  const pill = (className: string, role: string, title: string, label: string) => {
    const linkHint = linkToStatus ? " (open the status page)" : "";
    const inner = (
      <span className={className} role={role} title={title + linkHint}>
        {label}
      </span>
    );
    return linkToStatus ? (
      <Link to="/status" className="s3-status-link">
        {inner}
      </Link>
    ) : (
      inner
    );
  };

  // The poll itself failed (after its retry). TanStack keeps the last good
  // answer in `data`, so this has to come first.
  if (isError) {
    return pill(
      "conn conn-closed s3-alert",
      "alert",
      "The page's last status check of the RubinTV server failed, so what it shows may be out of date.",
      "Server unreachable",
    );
  }

  if (!data) return null; // nothing known yet

  const poll = pollFor(data, location);
  // Whose bucket a state is of: this location's, or the ones the summary
  // found in it.
  const bucket = (test: Parameters<typeof locationsWhere>[1]) => {
    if (location) return "this location's S3 bucket";
    const names = locationsWhere(data, test);
    return names.length ? `the S3 bucket for ${names.join(", ")}` : "the S3 bucket";
  };
  // The pill's words for a state: the plain label for one location's own
  // pill, or when every location summed is in it; else how many are, so
  // one bucket out of four doesn't read as S3 being out.
  const label = (
    test: Parameters<typeof locationsWhere>[1],
    whole: string,
    what: string,
    state: string,
  ) => {
    const total = location ? 0 : (data.locations?.length ?? 0);
    const count = locationsWhere(data, test).length;
    return count > 0 && count < total
      ? `${what}: ${count} of ${total} ${state}`
      : whole;
  };

  if (poll.poll_stalled) {
    const age = poll.last_poll_age_seconds;
    const last =
      age == null
        ? "It has not finished one since the server started."
        : `It last finished one at ${utcClock(dataUpdatedAt - age * 1000)} UTC.`;
    return pill(
      "conn conn-closed s3-alert",
      "alert",
      `The server's poll of ${bucket((l) => l.poll_stalled)} has stopped: a check it began over a minute ago has not finished, so new data is not being picked up. ${last} Check the server logs.`,
      label((l) => l.poll_stalled, "Poll stalled", "Poll", "stalled"),
    );
  }

  if (poll.s3_healthy === false) {
    return pill(
      "conn conn-closed s3-alert",
      "alert",
      `The server could not reach ${bucket((l) => !l.s3_healthy)} on its last poll. Check the server logs.`,
      label((l) => !l.s3_healthy, "S3 unreachable", "S3", "unreachable"),
    );
  }

  if (poll.s3_slow) {
    return pill(
      "conn s3-slow",
      "status",
      `The server's last poll of ${bucket((l) => l.s3_slow)} took ${poll.s3_last_cycle_seconds.toFixed(1)}s — unusually slow; the connection may be degrading.`,
      label((l) => l.s3_slow, "S3 slow", "S3", "slow"),
    );
  }

  if (verbose) {
    return pill(
      "conn conn-open",
      "status",
      location
        ? "The server reached this location's S3 bucket on its last poll."
        : "The server reached every location's S3 bucket on its last poll.",
      "S3 connected",
    );
  }

  return null; // healthy and quiet
}

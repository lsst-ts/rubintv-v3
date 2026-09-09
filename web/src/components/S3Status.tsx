import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

// S3-connectivity indicator beside the live (WebSocket) pill. The 'live' pill
// shows the browser↔app-server WS; this shows whether the app server is
// reaching the S3 bucket. It stays quiet when healthy and surfaces two
// escalating states the operator would otherwise only find in the logs:
//   - amber 'S3 slow'        — the last poll cycle was unusually slow, an
//                              early warning of a degrading link;
//   - red   'S3 unreachable' — the last cycle failed to reach S3 outright
//                              (e.g. a botocore connect timeout).
// 'unreachable' takes precedence over 'slow'.
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
  linkToStatus = false,
  verbose = false,
}: {
  linkToStatus?: boolean;
  verbose?: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["status"],
    queryFn: () => api.status(),
    // Always poll: connectivity can drop after loading completes, so unlike
    // the historical-loading banner this never stops watching.
    refetchInterval: 5000,
  });

  if (!data) return null; // nothing known yet

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

  if (data.s3_healthy === false) {
    return pill(
      "conn conn-closed s3-alert",
      "alert",
      "The server could not reach the S3 bucket on its last poll. Check the server logs.",
      "S3 unreachable",
    );
  }

  if (data.s3_slow) {
    return pill(
      "conn s3-slow",
      "status",
      `The server's last S3 poll took ${data.s3_last_cycle_seconds.toFixed(1)}s — unusually slow; the connection may be degrading.`,
      "S3 slow",
    );
  }

  if (verbose) {
    return pill(
      "conn conn-open",
      "status",
      "The server reached the S3 bucket on its last poll.",
      "S3 connected",
    );
  }

  return null; // healthy and quiet
}

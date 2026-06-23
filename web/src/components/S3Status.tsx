import { useQuery } from "@tanstack/react-query";
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
export function S3Status() {
  const { data } = useQuery({
    queryKey: ["status"],
    queryFn: () => api.status(),
    // Always poll: connectivity can drop after loading completes, so unlike
    // the historical-loading banner this never stops watching.
    refetchInterval: 5000,
  });

  if (!data) return null; // nothing known yet

  if (data.s3_healthy === false) {
    return (
      <span
        className="conn conn-closed s3-alert"
        role="alert"
        title="The server could not reach the S3 bucket on its last poll. Check the server logs."
      >
        S3 unreachable
      </span>
    );
  }

  if (data.s3_slow) {
    return (
      <span
        className="conn s3-slow"
        role="status"
        title="The server's last S3 poll was unusually slow — the connection may be degrading."
      >
        S3 slow
      </span>
    );
  }

  return null; // healthy and quiet
}

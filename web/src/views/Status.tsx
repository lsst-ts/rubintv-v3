import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { ConnectionStatus } from "../components/ConnectionStatus";
import { S3Status } from "../components/S3Status";
import type { CameraStatus } from "../lib/types";

// Site-wide operational view of historical-scan progress. Collection is
// per-camera (recent window first, then the full back-catalogue), so this
// surfaces each camera's two-stage readiness. Distinct from the per-location,
// admin-gated control-readback page (Admin.tsx): this is unguarded ops info.
// Polls /status until every camera's full sweep has completed.

type Stage = "pending" | "recent" | "complete";

function stageOf(c: CameraStatus): Stage {
  if (c.full_complete) return "complete";
  if (c.recent_ready) return "recent";
  return "pending";
}

const STAGE_LABEL: Record<Stage, string> = {
  pending: "Loading…",
  recent: "Recent ready",
  complete: "Complete",
};

function byLocation(
  cameras: CameraStatus[],
): Map<string, CameraStatus[]> {
  const groups = new Map<string, CameraStatus[]>();
  for (const c of cameras) {
    const list = groups.get(c.location) ?? [];
    list.push(c);
    groups.set(c.location, list);
  }
  return groups;
}

export function Status() {
  usePageTitle("Scan status");
  const { data, isPending, isError } = useQuery({
    queryKey: ["status"],
    queryFn: () => api.status(),
    // Keep polling while any camera is still completing its full sweep.
    refetchInterval: (query) => {
      const cams = query.state.data?.cameras ?? [];
      const allDone = cams.length > 0 && cams.every((c) => c.full_complete);
      return allDone ? false : 5000;
    },
  });

  const cameras = data?.cameras ?? [];
  const groups = byLocation(cameras);
  const remaining = cameras.filter((c) => !c.full_complete).length;

  return (
    <section className="scan-status">
      <h1>Scan status</h1>
      {/* One meta row for connection health: the WebSocket pill always shows
          the tab's browser↔app-server link; the S3 pill only appears when the
          server's bucket link is slow or unreachable (quiet when healthy);
          the last poll latency rides alongside even when healthy so a link
          degrading toward the slow threshold is visible before it crosses it
          (amber once flagged slow; hidden until a first cycle completes). */}
      <div className="status-connections">
        <ConnectionStatus />
        <S3Status />
        {data && data.s3_healthy && data.s3_last_cycle_seconds > 0 && (
          <span className="s3-latency" role="status">
            Last S3 poll cycle:{" "}
            <span className={data.s3_slow ? "s3-latency--slow" : undefined}>
              {data.s3_last_cycle_seconds.toFixed(1)}s
            </span>
          </span>
        )}
      </div>
      {isPending && <p className="skeleton">Loading status…</p>}
      {isError && <p role="alert">Could not load scan status.</p>}
      {data && !data.cache_enabled && (
        <p role="alert" className="scan-cache-warning">
          ⚠ Disk cache disabled — every restart reloads all history from S3.
          Set <code>cache_dir</code> to enable warm starts.
        </p>
      )}
      {data && data.cache_enabled && (
        <p role="note" className="scan-cache-mode">
          {data.warm_start
            ? "Warm start: calendar restored from cache; scans below are refreshing it against S3."
            : "Cold start: no cached snapshot loaded; older dates appear as the sweep below completes."}
        </p>
      )}
      {data && (
        <p className="scan-summary" role="status">
          {remaining === 0
            ? "All cameras fully loaded."
            : `${remaining} camera${remaining === 1 ? "" : "s"} still loading…`}
        </p>
      )}
      {/* One card per location, flowing side by side like the Admin page's
          boxes, each with its own done-count so per-site progress reads at a
          glance without scanning badge colours. */}
      <div className="scan-groups">
        {[...groups.entries()].map(([location, cams]) => {
          const done = cams.filter((c) => c.full_complete).length;
          return (
            <div key={location} className="scan-loc">
              <div className="scan-loc-head">
                <h2>{location}</h2>
                <span className="scan-loc-count">
                  {done}/{cams.length} complete
                </span>
              </div>
              <ul className="scan-cams">
                {cams.map((c) => {
                  const stage = stageOf(c);
                  return (
                    <li key={c.camera}>
                      <Link to={`/${c.location}/${c.camera}`}>{c.camera}</Link>
                      <span className={`scan-stage scan-stage--${stage}`}>
                        {STAGE_LABEL[stage]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

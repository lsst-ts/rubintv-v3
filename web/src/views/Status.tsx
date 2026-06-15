import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
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
    <section>
      <h1>Scan status</h1>
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
        <p role="status">
          {remaining === 0
            ? "All cameras fully loaded."
            : `${remaining} camera${remaining === 1 ? "" : "s"} still loading…`}
        </p>
      )}
      {[...groups.entries()].map(([location, cams]) => (
        <div key={location}>
          <h2>{location}</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Camera</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {cams.map((c) => {
                const stage = stageOf(c);
                return (
                  <tr key={c.camera}>
                    <td>
                      <Link to={`/${c.location}/${c.camera}`}>{c.camera}</Link>
                    </td>
                    <td>
                      <span className={`scan-stage scan-stage--${stage}`}>
                        {STAGE_LABEL[stage]}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

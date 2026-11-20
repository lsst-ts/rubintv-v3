import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import {
  roughAge,
  STALE_AFTER_MS,
  useLastPoll,
  useNow,
  utcClock,
} from "../lib/lastPoll";
import { ConnectionStatus } from "../components/ConnectionStatus";
import { S3Status } from "../components/S3Status";
import type { CacheEntry, CameraStatus } from "../lib/types";

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

// Kept to eight characters or fewer: the pills share one width (see CSS).
const STAGE_LABEL: Record<Stage, string> = {
  pending: "Loading…",
  recent: "Recent",
  complete: "Complete",
};

const STAGE_MEANING: Record<Stage, string> = {
  pending: "scanning the most recent days",
  recent: "recent days viewable; older history still loading",
  complete: "all history loaded",
};

// How the server started: whether the disk cache seeded the calendar. A pill
// beside the connection ones, its description in the tooltip; amber when the
// cache is off altogether, a misconfiguration worth noticing.
type CacheMode = "warm" | "cold" | "off";

const CACHE_MODE: Record<CacheMode, { label: string; hint: string }> = {
  warm: {
    label: "Warm start",
    hint: "Calendar restored from the disk cache at start-up; the scans are refreshing it against S3.",
  },
  cold: {
    label: "Cold start",
    hint: "No cached snapshot was loaded at start-up; older dates appear as the full sweep finds them.",
  },
  off: {
    label: "Disk cache disabled",
    hint: "Every restart reloads all history from S3. Set cache_dir to enable warm starts.",
  },
};

// Legend for the cards: what each stage pill means.
function ScanKey() {
  return (
    <div className="scan-key">
      <span className="scan-key-label">Key</span>
      <dl>
        {(Object.keys(STAGE_LABEL) as Stage[]).map((stage) => (
          <div key={stage}>
            <dt>
              <span className={`scan-stage scan-stage--${stage}`}>
                {STAGE_LABEL[stage]}
              </span>
            </dt>
            <dd>{STAGE_MEANING[stage]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

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

const CACHE_USE_LABEL: Record<CacheEntry["use"], string> = {
  index: "scan index (warm starts)",
  guide: "observing-block guide",
  unused: "not used by this version",
};

// Binary units, as `du -h` and the PVC's "1Gi" request count them.
function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

// Where the disk cache lives and what it takes, entry by entry: the scan
// index behind warm starts, the guide's, and anything this version no longer
// reads (an older cache version's slices), whose space can be reclaimed. Its
// own query, polled slower than /status: the server stats every cached file.
function CacheNotice() {
  const { data } = useQuery({
    queryKey: ["cacheUsage"],
    queryFn: () => api.cacheUsage(),
    refetchInterval: 30_000,
  });
  if (!data?.enabled) return null;
  const total = data.entries.reduce((sum, e) => sum + e.bytes, 0);
  const { volume_total_bytes: volTotal, volume_free_bytes: volFree } = data;
  return (
    <div role="note" className="cache-usage">
      <p>
        Disk cache in <code>{data.dir}</code>: {formatBytes(total)}
      </p>
      {/* The volume is whatever filesystem holds the cache dir — a laptop's
          whole disk in dev, the PVC in deployments — so its used space is
          the cache plus everything else on it (and filesystem overhead):
          cache + free needn't equal the total. Used is shown so the
          volume's own figures add up. */}
      {volTotal != null && volFree != null && (
        <p>
          {`Volume (shared with other files): ${formatBytes(volTotal - volFree)} used, ${formatBytes(volFree)} free, ${formatBytes(volTotal)} total`}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th className="cache-usage-num">Size</th>
            <th className="cache-usage-num">Files</th>
            <th>Use</th>
          </tr>
        </thead>
        <tbody>
          {data.entries.map((e) => {
            // The shared cache-dir prefix recedes so the entry's own name
            // (v3, guide…) is what the eye picks out down the column.
            const cut = e.path.lastIndexOf("/") + 1;
            return (
              <tr key={e.path} className={`cache-usage-row--${e.use}`}>
                <td>
                  <code>
                    <span className="cache-usage-dir">
                      {e.path.slice(0, cut)}
                    </span>
                    {e.path.slice(cut)}
                  </code>
                </td>
                <td className="cache-usage-num">{formatBytes(e.bytes)}</td>
                <td className="cache-usage-num">
                  {e.files.toLocaleString()}
                </td>
                <td>
                  <span className={`cache-use cache-use--${e.use}`}>
                    {CACHE_USE_LABEL[e.use]}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// When the server's last S3 poll cycle succeeded, and how long it took.
//
// The time is what shows a poll that has stopped: it stops moving, and turns
// amber with its age once that is more than a normal gap (the age is counted
// on the tab's clock, so it grows between status polls and while they fail).
// Hidden until a first cycle completes.
//
// The duration is shown even when healthy, so a link degrading toward the
// slow threshold is visible before it crosses it (amber once flagged slow).
// `seconds` is null while S3 is unreachable: the last cycle to succeed says
// nothing of the link now.
function LastPoll({ seconds, slow }: { seconds: number | null; slow: boolean }) {
  const at = useLastPoll();
  const now = useNow();
  if (at === null) return null;
  const age = now - at;
  const stale = age > STALE_AFTER_MS;
  return (
    <span
      className="s3-latency"
      title="When the server's last S3 poll cycle succeeded, and how long it took"
    >
      Last poll:{" "}
      <span className={stale ? "s3-latency--slow" : undefined}>
        {utcClock(at)} UTC
        {stale && ` (${roughAge(age)} ago)`}
      </span>
      {seconds !== null && (
        <>
          , took{" "}
          <span className={slow ? "s3-latency--slow" : undefined}>
            {seconds.toFixed(1)}s
          </span>
        </>
      )}
    </span>
  );
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

  const groups = byLocation(data?.cameras ?? []);
  const cacheMode: CacheMode | null = !data
    ? null
    : !data.cache_enabled
      ? "off"
      : data.warm_start
        ? "warm"
        : "cold";

  return (
    <section className="scan-status">
      {/* The title, with the page's indicators tucked small to its right, a
          row of pills: the two links it reports on — the tab's
          browser↔app-server WebSocket and the server↔bucket S3 poll — then
          how the server started (the cache mode). S3 gets the verbose pill
          (explicit green when healthy — quiet here would read as
          "unknown"). Under the row, on a quiet line of its own so it
          doesn't stretch it, when the last poll cycle succeeded and how
          long it took (see LastPoll). */}
      <div className="status-top">
        <h1>Scan status</h1>
        <div className="status-signals">
          <div className="status-sections">
            <section className="status-section" aria-label="WebSocket">
              <ConnectionStatus verbose />
            </section>
            <section className="status-section" aria-label="S3">
              <S3Status verbose />
            </section>
            {cacheMode && (
              <section className="status-section" aria-label="Start-up">
                <span
                  className={`conn cache-mode cache-mode--${cacheMode}`}
                  role={cacheMode === "off" ? "alert" : "status"}
                  title={CACHE_MODE[cacheMode].hint}
                >
                  {CACHE_MODE[cacheMode].label}
                </span>
              </section>
            )}
          </div>
          <LastPoll
            seconds={
              data && data.s3_healthy && data.s3_last_cycle_seconds > 0
                ? data.s3_last_cycle_seconds
                : null
            }
            slow={data?.s3_slow ?? false}
          />
        </div>
      </div>
      {isPending && <p className="skeleton">Loading status…</p>}
      {isError && <p role="alert">Could not load scan status.</p>}
      {/* Scan progress: the per-location cards, each with its own
          done-count so per-site progress reads at a glance without scanning
          badge colours, with the key beneath them; and set apart below, where
          the cache lives and its size. */}
      {data && (
        <section className="scan-progress">
          <div className="scan-groups">
            {[...groups.entries()].map(([location, cams]) => {
              const done = cams.filter((c) => c.full_complete).length;
              return (
                <div key={location} className="scan-loc">
                  <div className="scan-loc-head">
                    <h3>{cams[0].location_title}</h3>
                    <span className="scan-loc-count">
                      {done}/{cams.length} complete
                    </span>
                  </div>
                  <ul className="scan-cams">
                    {cams.map((c) => {
                      const stage = stageOf(c);
                      return (
                        <li key={c.camera}>
                          <Link to={`/${c.location}/${c.camera}`}>
                            {c.camera_title}
                          </Link>
                          {/* Running tally of what the scans have found,
                              so a sweep that's progressing reads as such
                              (and a camera stuck at 0 stands out). The
                              tooltip says what it counts. */}
                          <span
                            className="scan-images"
                            title="Images found so far"
                          >
                            {c.image_count.toLocaleString()}
                          </span>
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
          <ScanKey />
          {data.cache_enabled && <CacheNotice />}
        </section>
      )}
    </section>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import {
  hasAged,
  roughAge,
  STALE_AFTER_MS,
  useLastPoll,
  useNow,
  utcClock,
} from "../lib/lastPoll";
import {
  redisLinkFrom,
  unansweredFor,
  unansweredSince,
  utcWhen,
  type RedisLink,
} from "../lib/redisLink";
import { ConnectionStatus } from "../components/ConnectionStatus";
import { S3Status } from "../components/S3Status";
import type {
  CacheEntry,
  CacheProblem,
  CacheUsageResponse,
  CameraStatus,
  LocationStatus,
} from "../lib/types";

// Site-wide operational view of historical-scan progress. Collection is
// per-camera (recent window first, then the full back-catalogue), so this
// surfaces each camera's two-stage readiness. Distinct from the per-location,
// admin-gated control-readback page (Admin.tsx): this is unguarded ops info.
// Its header also reports the server's three links (see the pills below).
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

// The disk cache as the server finds it. Its own query, polled slower than
// /status: the server asks the volume each time.
function useCacheUsage() {
  return useQuery({
    queryKey: ["cacheUsage"],
    queryFn: () => api.cacheUsage(),
    refetchInterval: 30_000,
  }).data;
}

// What can be wrong with the cache volume, and what each costs. None of it
// stops the app (it reads the cache once, at startup, and otherwise only
// writes to it), so the pages look fine throughout and this page is the one
// place it shows.
const CACHE_PROBLEM: Record<
  CacheProblem["kind"],
  { label: string; means: string }
> = {
  not_responding: {
    label: "Cache not responding",
    means:
      "The cache volume has stopped answering. The pages stay live, as scans no longer wait for it, but nothing is being saved: a restart now would start from an older index, and may hang reading it.",
  },
  unreadable: {
    label: "Cache unreadable",
    means:
      "The server can't list the cache directory, so its size isn't known. A restart now would not find the saved index, and would load everything from S3 again.",
  },
  not_writable: {
    label: "Cache not writable",
    means:
      "New scan results aren't being saved, so a restart now would start from an older index.",
  },
};

// The cache's troubles as alert pills, for the top of the page: the notice
// that explains them is at the bottom, under the scan cards.
function CacheProblems() {
  const problems = useCacheUsage()?.problems ?? [];
  return (
    <>
      {problems.map((p) => (
        <span
          key={p.kind}
          className="conn conn-closed s3-alert"
          role="alert"
          title={`${CACHE_PROBLEM[p.kind].means} ${p.detail}.`}
        >
          {CACHE_PROBLEM[p.kind].label}
        </span>
      ))}
    </>
  );
}

// The cache's total size, as the notice gives it. A size the server couldn't
// measure reads "unknown", and one it hasn't measured yet says so: neither is
// the 0 B of an empty cache. The server sizes the entries only every few
// minutes, as that stats every cached file, so a size a minute old or more
// is given its age.
function cacheSize(data: CacheUsageResponse): string {
  if (data.problems.some((p) => p.kind !== "not_writable")) return "size unknown";
  const age = data.entries_age_seconds;
  if (age == null) return "being measured";
  const size = formatBytes(data.entries.reduce((sum, e) => sum + e.bytes, 0));
  const minutes = Math.floor(age / 60);
  return minutes < 1 ? size : `${size}, measured ${minutes} min ago`;
}

// Where the disk cache lives and what it takes, entry by entry: the scan
// index behind warm starts, the guide's, and anything this version no longer
// reads (an older cache version's slices), whose space can be reclaimed.
// Between the summary and the table, anything wrong with it: per problem
// its name, what it costs, and the server's own account of the cause, each
// on a line of its own.
function CacheNotice() {
  const data = useCacheUsage();
  if (!data?.enabled) return null;
  const { problems } = data;
  const { volume_total_bytes: volTotal, volume_free_bytes: volFree } = data;
  return (
    <div role="note" className="cache-usage">
      <p>
        Disk cache in <code>{data.dir}</code>:{" "}
        {cacheSize(data)}
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
      {problems.length > 0 && (
        <ul className="cache-problems">
          {problems.map((p) => (
            <li key={p.kind}>
              <strong>{CACHE_PROBLEM[p.kind].label}</strong>
              <span>{CACHE_PROBLEM[p.kind].means}</span>
              <span className="cache-problem-detail">{p.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {data.entries.length > 0 && (
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
                  <td className="cache-usage-num">
                    {e.unreadable ? "unknown" : formatBytes(e.bytes)}
                  </td>
                  <td className="cache-usage-num">
                    {e.unreadable ? "unknown" : e.files.toLocaleString()}
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
      )}
    </div>
  );
}

// When the server's last poll cycle of a location's bucket succeeded, and
// how long it took. On the location's card: each location is polled on its
// own, so no one time or duration stands for them all.
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
function LastPoll({ poll }: { poll: LocationStatus }) {
  const at = useLastPoll(poll.location);
  const now = useNow();
  if (at === null) return null;
  const age = now - at;
  const stale = age > STALE_AFTER_MS;
  const seconds =
    poll.s3_healthy && poll.s3_last_cycle_seconds > 0
      ? poll.s3_last_cycle_seconds
      : null;
  const slow = poll.s3_slow;
  return (
    <span
      className="s3-latency scan-loc-poll"
      title="When the server's last poll cycle of this location's S3 bucket succeeded, and how long it took"
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

// Whether the server is reading Redis, which carries the cluster status and
// the admin controls' readbacks: the third link this page reports on. Every
// state is shown, a deployment with no Redis included, since quiet here
// would read as "unknown".
function RedisPill({ link }: { link: RedisLink }) {
  const now = useNow();
  if (!link.configured) {
    return (
      <span
        className="conn conn-closed"
        role="status"
        title="No Redis is configured for this deployment, so there is no cluster status and the admin controls are off."
      >
        Redis not configured
      </span>
    );
  }
  if (link.connected) {
    return (
      <span
        className="conn conn-open"
        role="status"
        title="The server is reading Redis, which carries the cluster status and the admin controls' readbacks."
      >
        Redis connected
      </span>
    );
  }
  const age = unansweredFor(link, now);
  return (
    <span
      className="conn conn-closed s3-alert"
      role="alert"
      title={`The server has had no answer from Redis ${unansweredSince(link, now)}${age === null ? "" : ` (${age})`}. The Cluster Status and Admin pages show what it last said. The server keeps trying, at least twice a minute; check its logs.`}
    >
      Redis unreachable
    </span>
  );
}

// When Redis last answered the server: what the Cluster Status and Admin
// pages are "as of". A few seconds old at most while Redis is connected (the
// server asks at least that often, and this page asks the server every 5),
// so it reads like LastPoll's time: amber, with its age, once it has stopped
// moving. Hidden where there is no Redis, or it has yet to answer.
function LastRedisRead({ link }: { link: RedisLink }) {
  const now = useNow();
  if (!link.configured || link.readAt === null) return null;
  const age = now - link.readAt;
  const stale = !link.connected || age > STALE_AFTER_MS;
  return (
    <span className="s3-latency" title="When Redis last answered the server">
      Redis last read:{" "}
      <span className={stale ? "s3-latency--slow" : undefined}>
        {utcWhen(link.readAt, now)}
        {stale && hasAged(age) && ` (${roughAge(age)} ago)`}
      </span>
    </span>
  );
}

export function Status() {
  usePageTitle("Scan status");
  const { data, dataUpdatedAt, isPending, isError } = useQuery({
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
  const redis = redisLinkFrom(data?.redis, dataUpdatedAt);
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
          row of pills: the three links it reports on — the tab's
          browser↔app-server WebSocket, the server↔bucket S3 poll and the
          server↔Redis readers — then how the server started (the cache mode)
          and anything wrong with the cache. S3 gets the verbose pill
          (explicit green when healthy — quiet here would read as "unknown"),
          which here sums every location's poll: each location's card below
          carries its own when it is in trouble, and when its last poll
          cycle succeeded (see LastPoll).
          Under the row, on a quiet line of its own so it doesn't stretch
          it, when Redis last answered (see LastRedisRead). */}
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
            {redis && (
              <section className="status-section" aria-label="Redis">
                <RedisPill link={redis} />
              </section>
            )}
            {cacheMode && (
              <section className="status-section" aria-label="Start-up">
                <span
                  className={`conn cache-mode cache-mode--${cacheMode}`}
                  role={cacheMode === "off" ? "alert" : "status"}
                  title={CACHE_MODE[cacheMode].hint}
                >
                  {CACHE_MODE[cacheMode].label}
                </span>
                {cacheMode !== "off" && <CacheProblems />}
              </section>
            )}
          </div>
          {redis && <LastRedisRead link={redis} />}
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
              // The location's own poll, where the server reports it.
              const poll = data.locations?.find((l) => l.location === location);
              return (
                <div key={location} className="scan-loc">
                  <div className="scan-loc-head">
                    <h3>{cams[0].location_title}</h3>
                    {/* Each location is polled on its own, so the header's
                        S3 pill, which sums them, can't say which one it
                        means. A location whose own poll is in trouble says
                        so here; a healthy one stays quiet. Only where the
                        server reports the location's own: the pill would
                        fall back on the summary and repeat the header. */}
                    <span className="scan-loc-state">
                      {poll && <S3Status location={location} />}
                      <span className="scan-loc-count">
                        {done}/{cams.length} complete
                      </span>
                    </span>
                  </div>
                  {poll && <LastPoll poll={poll} />}
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

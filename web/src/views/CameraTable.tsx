import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys, type MetadataProgress } from "../lib/liveQuery";
import type { Metadata } from "../lib/types";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { useColumnPrefs } from "../lib/columns";
import { ShareLink } from "../components/ShareLink";
import { AllSky } from "./AllSky";

// The main camera view: date picker, per-seq-num table with channel columns
// and metadata columns, per-day artifacts, night-report link. Subscribes to
// the camera topic so new rows appear live (today) without a reload.
export function CameraTable() {
  const { location = "", camera = "" } = useParams();
  const [params, setParams] = useSearchParams();

  const { data: cameraInfo } = useQuery({
    queryKey: queryKeys.camera(location, camera),
    queryFn: () => api.camera(location, camera),
    staleTime: STALE.config,
  });

  const { data: calendar } = useQuery({
    queryKey: queryKeys.calendar(location, camera),
    queryFn: () => api.calendar(location, camera),
    staleTime: STALE.calendar,
  });

  // Default to the most recent date with data.
  const date = params.get("date") ?? calendar?.dates[0] ?? "";

  // Live updates for this camera (drives table + calendar invalidation).
  // Passing the resolved date also asks the server to stream that date's
  // metadata as it loads, so cells fill progressively rather than after one
  // big REST round-trip.
  useLiveTopic(date ? { topic: "camera", location, camera, date } : null);

  // Progress of the streamed metadata (null once complete / not streaming).
  // These two values are pushed by applyLiveMessage via setQueryData; the
  // queryFn is only a seed so TanStack doesn't warn about a missing fetcher,
  // and staleTime keeps it from ever overwriting a pushed value.
  const { data: metaProgress } = useQuery<MetadataProgress | null>({
    queryKey: queryKeys.metadataProgress(location, camera, date),
    queryFn: () => null,
    staleTime: Infinity,
  });
  // Metadata streamed over the WebSocket, accumulated as chunks arrive. Kept
  // separate from the REST payload and merged below, so streamed rows show up
  // immediately even before the (also slow) REST payload lands.
  const { data: streamedMeta } = useQuery<Metadata>({
    queryKey: queryKeys.metadataStream(location, camera, date),
    queryFn: () => ({}),
    staleTime: Infinity,
  });

  const { data: payload, isPending } = useQuery({
    queryKey: queryKeys.datePayload(location, camera, date),
    queryFn: () => api.datePayload(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  // Metadata is fetched independently of the structured payload so the grid
  // (channels/seqs) renders immediately from cache without waiting on this
  // large, live-from-S3 download. It's the backstop for the WS stream.
  const { data: restMeta } = useQuery<Metadata>({
    queryKey: queryKeys.metadata(location, camera, date),
    queryFn: () => api.metadata(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  // The metadata the table renders: streamed rows merged with the REST
  // backstop. The stream usually arrives first on slow links; REST fills any
  // chunk that was dropped (and covers clients whose stream never connects).
  const metadata = useMemo<Metadata>(
    () => ({ ...(streamedMeta ?? {}), ...(restMeta ?? {}) }),
    [streamedMeta, restMeta],
  );

  const channelNames = useMemo(
    () => cameraInfo?.channels.filter((c) => !c.per_day).map((c) => c.name) ?? [],
    [cameraInfo],
  );
  // Columns are the union of the configured columns (which carry order and
  // tooltip descriptions) and every key actually present in the metadata —
  // metadata.json routinely carries far more fields than the config names,
  // and the old app surfaced all of them. Configured columns come first (in
  // config order); data-only keys follow, sorted case-insensitively. Keys
  // beginning with "_" (per-cell indicators) or "@" (empty-channel
  // replacement strings) are not columns — they decorate other cells.
  const metaColumns = useMemo(() => {
    const configured = Object.keys(cameraInfo?.metadata_columns ?? {});
    const seen = new Set(configured);
    const extra: string[] = [];
    for (const row of Object.values(metadata)) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          extra.push(key);
        }
      }
    }
    extra.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return [...configured, ...extra].filter(
      (name) => name[0] !== "_" && name[0] !== "@",
    );
  }, [cameraInfo, metadata]);
  const { visible, hidden, toggle } = useColumnPrefs(location, camera, metaColumns);

  // Union of seq_nums across channels and metadata, descending (newest
  // first). Including metadata keys means streamed rows appear immediately,
  // before the (slower) REST channel payload lands.
  const seqNums = useMemo(() => {
    const s = new Set<number>();
    for (const seqs of Object.values(payload?.channels ?? {})) {
      for (const n of seqs) if (typeof n === "number") s.add(n);
    }
    for (const key of Object.keys(metadata)) {
      const n = Number(key);
      if (Number.isInteger(n)) s.add(n);
    }
    return [...s].sort((a, b) => b - a);
  }, [payload, metadata]);

  // Live-view cameras (e.g. All Sky) show a single latest-image/latest-movie
  // panel instead of a per-seq-num table. Delegate once the config has loaded.
  // Placed after all hooks above so the rules-of-hooks order is unconditional.
  if (cameraInfo?.live_view) {
    return <AllSky />;
  }

  return (
    <section>
      <header className="table-header">
        <h1>{cameraInfo?.title ?? camera}</h1>
        {payload?.has_night_report && (
          <Link to={`/${location}/${camera}/night-report?date=${date}`}>
            View nightly summary
          </Link>
        )}
      </header>

      <div className="controls">
        <label>
          Date{" "}
          <select
            value={date}
            onChange={(e) => setParams({ date: e.target.value })}
          >
            {calendar?.dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <ShareLink date={date || undefined} />
        {metaProgress && metaProgress.rows > 0 && (
          <span className="metadata-progress" role="status">
            loading metadata… {metaProgress.rows} rows
          </span>
        )}
        <details className="column-picker">
          <summary>Columns ({visible.length}/{metaColumns.length})</summary>
          {metaColumns.map((col) => (
            <label key={col}>
              <input
                type="checkbox"
                checked={!hidden.has(col)}
                onChange={() => toggle(col)}
              />
              {col}
            </label>
          ))}
        </details>
      </div>

      {isPending && date !== "" && <p className="skeleton">Loading…</p>}

      {payload && Object.keys(payload.per_day).length > 0 && (
        <div className="per-day">
          {Object.entries(payload.per_day).map(([chan, key]) => (
            <span key={chan} className="per-day-item">
              {chan}: {key.split("/").pop()}
            </span>
          ))}
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Seq</th>
            {channelNames.map((c) => (
              <th key={c}>{c}</th>
            ))}
            {visible.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {seqNums.map((seq) => {
            const meta = metadata[String(seq)] ?? {};
            return (
              <tr key={seq}>
                <td>{seq}</td>
                {channelNames.map((chan) => {
                  const present = (payload?.channels[chan] ?? []).includes(seq);
                  return (
                    <td key={chan}>
                      {present ? (
                        <Link
                          to={`/${location}/${camera}/${chan}?seq=${seq}&date=${date}`}
                        >
                          ●
                        </Link>
                      ) : (
                        ""
                      )}
                    </td>
                  );
                })}
                {visible.map((col) => (
                  <td key={col}>{formatCell(meta[col])}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  return String(value);
}

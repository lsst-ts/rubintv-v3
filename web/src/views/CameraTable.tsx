import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys, type MetadataProgress } from "../lib/liveQuery";
import type { Metadata } from "../lib/types";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { useColumnPrefs } from "../lib/columns";
import { fillTemplate, isDevInstance } from "../lib/links";
import { usePageTitle } from "../lib/usePageTitle";
import { ShareLink } from "../components/ShareLink";
import { CopyButton } from "../components/CopyButton";
import { DownloadMetadata } from "../components/DownloadMetadata";
import { AllSky } from "./AllSky";

// The main camera view: date picker, per-seq-num table with channel columns
// and metadata columns, per-day artifacts, night-report link. Subscribes to
// the camera topic so new rows appear live (today) without a reload.
export function CameraTable() {
  const { location = "", camera = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();

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

  // Live-view cameras delegate to <AllSky> below, which sets its own title;
  // skip ours so we don't briefly flash a table title before that mounts.
  usePageTitle(
    !cameraInfo?.live_view && (cameraInfo?.title ?? camera),
    !cameraInfo?.live_view && date,
  );

  // The picker must always display the date actually being viewed. A
  // deep-linked date the scanner hasn't indexed yet isn't in the calendar,
  // and a <select> whose value matches no option silently displays the
  // first one — making it look like the latest day is shown. Splice the
  // resolved date in (newest-first order, matching the calendar).
  const pickerDates = useMemo(() => {
    const dates = calendar?.dates ?? [];
    if (!date || dates.includes(date)) return dates;
    return [...dates, date].sort().reverse();
  }, [calendar, date]);

  // Live updates for this camera (drives table + calendar invalidation).
  // Passing the resolved date also asks the server to stream that date's
  // metadata as it loads, so cells fill progressively rather than after one
  // big REST round-trip.
  useLiveTopic(date ? { topic: "camera", location, camera, date } : null);

  // Progress of the streamed metadata (null once complete / not streaming).
  // These two values are PUSHED by applyLiveMessage via setQueryData; their
  // fetcher must only reflect the cache, never produce a default — a queryFn
  // returning `null`/`{}` would run on mount and clobber the value the WS
  // stream just pushed (the bug that hid the progress indicator). Returning
  // the cached value keeps the fetcher inert while still registering one (no
  // "missing queryFn" warning) and staleTime:Infinity stops refetches.
  const progressKey = queryKeys.metadataProgress(location, camera, date);
  const { data: metaProgress } = useQuery<MetadataProgress | null>({
    queryKey: progressKey,
    queryFn: () => qc.getQueryData<MetadataProgress | null>(progressKey) ?? null,
    staleTime: Infinity,
  });
  // Metadata streamed over the WebSocket, accumulated as chunks arrive. Kept
  // separate from the REST payload and merged below, so streamed rows show up
  // immediately even before the (also slow) REST payload lands.
  const streamKey = queryKeys.metadataStream(location, camera, date);
  const { data: streamedMeta } = useQuery<Metadata>({
    queryKey: streamKey,
    queryFn: () => qc.getQueryData<Metadata>(streamKey) ?? {},
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
  const { data: restMeta, isSuccess: restMetaLoaded } = useQuery<Metadata>({
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

  // Per-row action links/buttons, driven by per-camera config. Each is shown
  // only when its template is configured. {dev} and {siteLoc} are fixed for the
  // running instance; {dayObs}/{seqNum}/{controller} vary per row and are
  // filled inside the row map below.
  const viewerTmpl = cameraInfo?.image_viewer_link ?? null;
  const quicklookTmpl = cameraInfo?.quicklook_viewer_link ?? null;
  const copyRowTmpl = cameraInfo?.copy_row_template ?? null;
  const dev = isDevInstance();
  // siteLocation keys the {siteLoc}→domain map; only summit/base resolve to a
  // domain. The URL's location segment is that key.
  const linkCtx = (controller?: unknown) => ({
    siteLocation: location,
    controller: typeof controller === "string" ? controller : undefined,
    isDevInstance: dev,
  });
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
            {pickerDates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <ShareLink date={date || undefined} />
        <DownloadMetadata
          metadata={metadata}
          filename={`${camera}_${date}_metadata.json`}
          // Enabled only once metadata is fully loaded: the authoritative REST
          // payload has resolved AND no WS stream is still arriving (a non-null
          // metaProgress means more chunks are in flight). Downloading mid-load
          // would save a partial file.
          disabled={date === "" || !restMetaLoaded || metaProgress != null}
        />
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
            {viewerTmpl && <th>Viewer</th>}
            {quicklookTmpl && <th>Quicklook</th>}
            {copyRowTmpl && <th />}
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
                {viewerTmpl && (
                  <td>
                    <a
                      href={fillTemplate(viewerTmpl, date, seq, linkCtx(meta.controller))}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Viewer
                    </a>
                  </td>
                )}
                {quicklookTmpl && (
                  <td>
                    <a
                      href={fillTemplate(quicklookTmpl, date, seq, linkCtx(meta.controller))}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Quicklook
                    </a>
                  </td>
                )}
                {copyRowTmpl && (
                  <td>
                    <CopyButton
                      text={fillTemplate(copyRowTmpl, date, seq, linkCtx(meta.controller))}
                    />
                  </td>
                )}
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

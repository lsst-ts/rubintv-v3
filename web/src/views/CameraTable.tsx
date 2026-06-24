import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys, type MetadataProgress } from "../lib/liveQuery";
import type { Metadata } from "../lib/types";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { useColumnPrefs } from "../lib/columns";
import { useDismiss } from "../lib/useDismiss";
import { isDevInstance } from "../lib/links";
import { usePageTitle } from "../lib/usePageTitle";
import { ShareLink } from "../components/ShareLink";
import { DownloadMetadata } from "../components/DownloadMetadata";
import { ColumnsIcon, ChevronDownIcon } from "../components/Icons";
import { DatePicker } from "../components/DatePicker";
import { FilterControl, FilterBar } from "../components/FilterControl";
import { LiveClocks } from "../components/LiveClocks";
import {
  matchRow,
  SEQ_COL,
  seqFilterToFilters,
  filtersToSeqFilter,
  type Filter,
} from "../lib/filters";
import { AllSky } from "./AllSky";
import { CameraDataTable, type Density } from "./CameraDataTable";

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

  const { data: calendar, isPending: calendarPending } = useQuery({
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

  // Adjacent dates with data for the prev/next-day steppers. pickerDates is
  // newest-first, so the older day sits at index+1 and the newer at index-1.
  const dateIdx = pickerDates.indexOf(date);
  const olderDate =
    dateIdx >= 0 && dateIdx < pickerDates.length - 1
      ? pickerDates[dateIdx + 1]
      : null;
  const newerDate = dateIdx > 0 ? pickerDates[dateIdx - 1] : null;

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

  const liveChannels = useMemo(
    () => cameraInfo?.channels.filter((c) => !c.per_day) ?? [],
    [cameraInfo],
  );
  const channelColour = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of liveChannels) m[c.name] = c.colour ?? "var(--accent)";
    return m;
  }, [liveChannels]);

  // Row density (compact / regular), persisted per browser.
  const [density, setDensity] = useState<Density>(() => {
    try {
      const d = localStorage.getItem("rubintv.density");
      if (d === "compact" || d === "regular") return d;
    } catch {
      // ignore
    }
    return "regular";
  });
  const pickDensity = (d: Density) => {
    try {
      localStorage.setItem("rubintv.density", d);
    } catch {
      // ignore
    }
    setDensity(d);
  };

  const [colsOpen, setColsOpen] = useState(false);
  const [colsQuery, setColsQuery] = useState("");
  // Dismiss the column picker on an outside click or Escape.
  const colsRef = useRef<HTMLDivElement | null>(null);
  useDismiss(colsOpen, colsRef, () => setColsOpen(false));

  // Per-row action links/buttons, driven by per-camera config. Each is shown
  // only when its template is configured. {dev} and {siteLoc} are fixed for the
  // running instance; {dayObs}/{seqNum}/{controller} vary per row and are
  // filled inside the row map below.
  const viewerTmpl = cameraInfo?.image_viewer_link ?? null;
  const quicklookTmpl = cameraInfo?.quicklook_viewer_link ?? null;
  const copyRowTmpl = cameraInfo?.copy_row_template ?? null;
  const dev = isDevInstance();
  // siteLocation keys the {siteLoc}→domain map; only summit/base resolve to a
  // domain. The URL's location segment is that key. Stable identity so it
  // doesn't defeat the memoized data table.
  const linkCtx = useCallback(
    (controller?: unknown) => ({
      siteLocation: location,
      controller: typeof controller === "string" ? controller : undefined,
      isDevInstance: dev,
    }),
    [location, dev],
  );
  // Columns are the union of the configured columns (which carry order and
  // tooltip descriptions) and every key actually present in the metadata —
  // metadata.json routinely carries far more fields than the config names,
  // and the old app surfaced all of them. Configured columns come first (in
  // config order); data-only keys follow, sorted case-insensitively. Keys
  // beginning with "_" (per-cell indicators) or "@" (empty-channel
  // replacement strings) are not columns — they decorate other cells.
  // The configured columns (metadata_columns) are the default-visible set.
  const defaultColumns = useMemo(
    () =>
      Object.keys(cameraInfo?.metadata_columns ?? {}).filter(
        (name) => name[0] !== "_" && name[0] !== "@",
      ),
    [cameraInfo],
  );
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
  const { visible, hidden, toggle, showAll, hideAll, reset } = useColumnPrefs(
    location,
    camera,
    metaColumns,
    defaultColumns,
  );

  // All active filters live here, including any on the synthetic Seq.No column.
  // A Seq.No filter is shareable via a single catch-all ?seq_filter param that
  // carries every operator (range, =, >, <, between, in, …) — scoped to Seq.No
  // so it doesn't imply arbitrary columns are URL-passable. It *seeds* the
  // filters on load and is *mirrored* from them on change. Metadata-column
  // filters stay local + ephemeral (reset on date/camera change).
  const [filters, setFilters] = useState<Filter[]>(() =>
    seqFilterToFilters(params.get("seq_filter")),
  );
  // Reset to the URL-seeded Seq.No filter whenever the view (camera/date) changes.
  useEffect(() => {
    setFilters(seqFilterToFilters(params.get("seq_filter")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, camera, date]);

  // Columns offered in the filter popover: the metadata columns plus the
  // synthetic Seq.No. Seq.No goes last so the popover defaults to a metadata
  // column (the common case) while a seq-range filter is still selectable.
  const filterColumns = useMemo(() => [...metaColumns, SEQ_COL], [metaColumns]);

  // Keep ?seq_filter in sync with the current Seq.No clauses so the filter stays
  // shareable.
  const seqFilter = useMemo(() => filtersToSeqFilter(filters), [filters]);
  useEffect(() => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (seqFilter) p.set("seq_filter", seqFilter);
        else p.delete("seq_filter");
        return p;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seqFilter]);

  // Picker rows filtered by the search box (substring, case-insensitive).
  const colsMatches = useMemo(() => {
    const q = colsQuery.trim().toLowerCase();
    return q
      ? metaColumns.filter((c) => c.toLowerCase().includes(q))
      : metaColumns;
  }, [colsQuery, metaColumns]);

  // Union of seq_nums across channels and metadata, descending (newest
  // first). Including metadata keys means streamed rows appear immediately,
  // before the (slower) REST channel payload lands.
  const allSeqNums = useMemo(() => {
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

  // Rows surviving the active filters (the table renders these).
  const seqNums = useMemo(
    () =>
      filters.length === 0
        ? allSeqNums
        : allSeqNums.filter((n) => matchRow(n, metadata[String(n)], filters)),
    [allSeqNums, filters, metadata],
  );

  // Header clocks: the time-since clock shows only on the current (live) date,
  // for cameras that have one configured, computed from the newest exposure's
  // "Date begin" timestamp.
  const isCurrentDate = date !== "" && date === calendar?.dates[0];
  const sinceLabel =
    isCurrentDate && cameraInfo?.time_since_clock
      ? cameraInfo.time_since_clock.label
      : null;
  const lastImageTime = useMemo(() => {
    const newest = allSeqNums[0];
    if (newest === undefined) return null;
    const v = metadata[String(newest)]?.["Date begin"];
    return v == null ? null : String(v);
  }, [allSeqNums, metadata]);

  // The full ordered column model: sticky seq, channel chips, per-row action
  // columns (only those configured), then the visible metadata columns. The
  // angled-header overlay draws a label per non-seq column.
  const columns = useMemo(() => {
    const cols: { key: string; label: string }[] = [
      { key: "seq", label: "Seq.No" },
      // Column key is the channel's ref name (cells index by it); the header
      // label is its human title.
      ...liveChannels.map((c) => ({ key: `ch:${c.name}`, label: c.title })),
    ];
    // Per-row action columns carry no header label.
    if (viewerTmpl) cols.push({ key: "viewer", label: "" });
    if (quicklookTmpl) cols.push({ key: "quicklook", label: "" });
    if (copyRowTmpl) cols.push({ key: "copy", label: "" });
    for (const c of visible) cols.push({ key: `meta:${c}`, label: c });
    return cols;
  }, [liveChannels, viewerTmpl, quicklookTmpl, copyRowTmpl, visible]);

  // Live-view cameras (e.g. All Sky) show a single latest-image/latest-movie
  // panel instead of a per-seq-num table. Delegate once the config has loaded.
  // Placed after all hooks above so the rules-of-hooks order is unconditional.
  if (cameraInfo?.live_view) {
    return <AllSky />;
  }

  return (
    <section className="cam-table">
      {/* Toolbar: date, share, columns, filter, download · density, night report. */}
      <div className="cam-toolbar">
        <span className="date-stepper">
          <button
            type="button"
            className="tb-btn step"
            aria-label="Previous day with data"
            title="Previous day with data"
            disabled={!olderDate}
            onClick={() => olderDate && setParams({ date: olderDate })}
          >
            ‹
          </button>
          <DatePicker
            dates={pickerDates}
            counts={calendar?.counts ?? {}}
            maxSeq={calendar?.max_seq ?? {}}
            allSky={cameraInfo?.live_view ?? false}
            value={date}
            onChange={(d) => setParams({ date: d })}
          />
          <button
            type="button"
            className="tb-btn step"
            aria-label="Next day with data"
            title="Next day with data"
            disabled={!newerDate}
            onClick={() => newerDate && setParams({ date: newerDate })}
          >
            ›
          </button>
        </span>
        <ShareLink date={date || undefined} />

        <div className="cols-cluster" ref={colsRef}>
          <button
            type="button"
            className="tb-btn"
            aria-expanded={colsOpen}
            onClick={() => setColsOpen((o) => !o)}
          >
            <ColumnsIcon />
            <span>Columns</span>
            <span className="frac">
              {visible.length}/{metaColumns.length}
            </span>
            <ChevronDownIcon />
          </button>
          {/* Kept mounted and toggled with `hidden` rather than conditionally
              rendered: building the ~150 column rows on click cost ~300ms of
              jank. They mount once with the table; opening only flips display. */}
          <div className="cols-pop" hidden={!colsOpen}>
            <div className="picker-head">
              <span className="title">Metadata columns</span>
              <span className="count">
                <b>{visible.length}</b> of {metaColumns.length} shown
              </span>
              <input
                className="search"
                type="text"
                placeholder="search columns…"
                value={colsQuery}
                onChange={(e) => setColsQuery(e.target.value)}
                aria-label="Search columns"
              />
              <div className="bulk">
                <button type="button" onClick={showAll} title="Show all metadata columns">
                  all
                </button>
                <button type="button" onClick={hideAll} title="Hide all metadata columns">
                  none
                </button>
                <button type="button" onClick={reset} title="Restore default columns">
                  reset
                </button>
              </div>
            </div>
            <div className="picker-body">
              {colsMatches.length === 0 ? (
                <div className="picker-empty">no columns match “{colsQuery}”</div>
              ) : (
                <div className="cols-grid">
                  {colsMatches.map((col) => (
                    <label
                      key={col}
                      className={hidden.has(col) ? "picker-item dim" : "picker-item"}
                    >
                      <input
                        type="checkbox"
                        checked={!hidden.has(col)}
                        onChange={() => toggle(col)}
                      />
                      <span className="label-text">{col}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <FilterControl
          columns={filterColumns}
          metadata={metadata}
          filters={filters}
          setFilters={setFilters}
        />

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

        <span className="tb-grow" />

        <LiveClocks sinceLabel={sinceLabel} lastImage={lastImageTime} />

        <div className="density-seg" role="group" aria-label="Row density">
          {(["compact", "regular"] as Density[]).map((d) => (
            <button
              key={d}
              type="button"
              className={density === d ? "active" : ""}
              aria-pressed={density === d}
              onClick={() => pickDensity(d)}
            >
              {d}
            </button>
          ))}
        </div>

        {payload?.has_night_report && (
          <Link
            className="tb-btn"
            to={`/${location}/${camera}/night-report?date=${date}`}
          >
            Night report
          </Link>
        )}
      </div>

      <FilterBar metadata={metadata} filters={filters} setFilters={setFilters} />

      {((isPending && date !== "") || (date === "" && calendarPending)) && (
        <p className="skeleton">Loading…</p>
      )}

      {payload && Object.keys(payload.per_day).length > 0 && (
        <div className="per-day">
          {Object.entries(payload.per_day).map(([chan, key]) => (
            <span key={chan} className="per-day-item">
              {chan}: {key.split("/").pop()}
            </span>
          ))}
        </div>
      )}

      {/* Empty states: no date available for this camera at all, or the
          resolved date finished loading with no rows. Either way, skip the
          (tall, angled-header) table and show a tidy notice instead. */}
      {date === "" ? (
        /* No resolved date: either the calendar is still loading (the loader
           above covers it) or it loaded with no dates for this camera. */
        calendarPending ? null : (
          <div className="table-empty">
            No dates with data for this camera yet.
          </div>
        )
      ) : seqNums.length === 0 ? (
        /* No rows yet. While the payload (or a deep-linked date's on-demand
           backfill) is still in flight, the loader above stands in — don't
           also render an empty table or a premature "no data" notice. */
        isPending ? null : (
          <div className="table-empty">
            {allSeqNums.length > 0 && filters.length > 0
              ? `No rows match the active filter${filters.length === 1 ? "" : "s"}.`
              : `No data for ${date}.`}
          </div>
        )
      ) : (
        <CameraDataTable
          columns={columns}
          seqNums={seqNums}
          metadata={metadata}
          payload={payload}
          channelColour={channelColour}
          density={density}
          location={location}
          camera={camera}
          date={date}
          viewerTmpl={viewerTmpl}
          quicklookTmpl={quicklookTmpl}
          copyRowTmpl={copyRowTmpl}
          linkCtx={linkCtx}
        />
      )}
    </section>
  );
}

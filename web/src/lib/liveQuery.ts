// Bridge WebSocket messages to TanStack Query cache. A live ServerMessage
// names the (location, camera, date) that changed; we invalidate the
// matching query keys so the affected view refetches (or, where the message
// carries data, it could setQueryData directly). Keeping it invalidation-
// based is simplest and correct: the REST endpoint is the formatter.

import type { QueryClient } from "@tanstack/react-query";
import { debugLog } from "./debug";

export interface ServerMessage {
  type: string;
  location?: string;
  camera?: string;
  date?: string;
  data?: Record<string, unknown>;
  // Metadata streaming progress (metadataChunk / metadataComplete).
  seq?: number;
  total?: number;
  etag?: string;
}

// Query key builders shared with the views.
export const queryKeys = {
  locations: () => ["locations"] as const,
  location: (loc: string) => ["location", loc] as const,
  camera: (loc: string, cam: string) => ["camera", loc, cam] as const,
  calendar: (loc: string, cam: string) => ["calendar", loc, cam] as const,
  datePayload: (loc: string, cam: string, date: string) =>
    ["datePayload", loc, cam, date] as const,
  nightReport: (loc: string, cam: string, date: string) =>
    ["nightReport", loc, cam, date] as const,
  // The REST metadata.json for a (loc, cam, date) — the backstop fetched
  // independently of the structured date payload, so the grid never waits on
  // it. Merged with the streamed metadata at render time.
  metadata: (loc: string, cam: string, date: string) =>
    ["metadata", loc, cam, date] as const,
  // Progress of the WS metadata stream for a (loc, cam, date). Written by
  // applyLiveMessage, read by the views to show a running row count while
  // metadata streams in. null once complete (or never started).
  metadataProgress: (loc: string, cam: string, date: string) =>
    ["metadataProgress", loc, cam, date] as const,
  // Accumulated streamed metadata for a (loc, cam, date): what the views
  // render. Kept separate from the REST date payload so streamed rows are
  // never lost to the payload's load lifecycle; useMetadata merges the two.
  metadataStream: (loc: string, cam: string, date: string) =>
    ["metadataStream", loc, cam, date] as const,
  // The rows of the stream currently in flight, from its seq 0. Promoted to
  // metadataStream wholesale when every chunk has arrived, so a re-stream
  // after the file was rewritten drops rows deleted server-side instead of
  // leaving them as ghosts in an add-only slot.
  metadataPending: (loc: string, cam: string, date: string) =>
    ["metadataPending", loc, cam, date] as const,
  // Outcome of the last stream: "streaming" while chunks arrive, "complete"
  // when every chunk landed, "incomplete" when some were dropped (the server
  // drops frames for a slow client) — the one case the REST backstop is for.
  metadataStreamStatus: (loc: string, cam: string, date: string) =>
    ["metadataStreamStatus", loc, cam, date] as const,
  // The version (S3 ETag) of the metadata the shown rows represent, from the
  // last complete stream or delta. Handed back on refresh so the server can
  // send just the difference.
  metadataEtag: (loc: string, cam: string, date: string) =>
    ["metadataEtag", loc, cam, date] as const,
  // Site-wide live state pushed over the WS. Both are written by
  // applyLiveMessage via setQueryData (snapshot on subscribe, then deltas)
  // and read by the Detectors / Admin views with an inert cache-only queryFn.
  detectorStatus: () => ["detectorStatus"] as const,
  controlReadback: () => ["controlReadback"] as const,
};

/** Progress of an in-flight metadata stream. The total isn't known until the
 *  stream ends (it parses incrementally), so we report rows received so far,
 *  and count chunks so completion can tell whether any were dropped. */
export interface MetadataProgress {
  rows: number;
  chunks: number;
}

export type MetadataStreamStatus = "streaming" | "complete" | "incomplete";

/** Apply a live message by invalidating the affected cached queries. */
export function applyLiveMessage(qc: QueryClient, msg: ServerMessage): void {
  const { type, location, camera, date } = msg;

  // Site-wide topics (detectors, admin) carry no location/camera; their
  // payload travels in `data`. Handle them before the per-camera guard and
  // write straight into the cache slot the view reads.
  if (type === "detectorStatus") {
    qc.setQueryData(
      queryKeys.detectorStatus(),
      (msg.data?.detectors as unknown) ?? {},
    );
    return;
  }
  if (type === "controlReadback") {
    qc.setQueryData(
      queryKeys.controlReadback(),
      (msg.data?.controls as unknown) ?? {},
    );
    return;
  }

  if (!location || !camera) return;

  // Metadata streaming: merge each chunk straight into the date payload's
  // metadata so cells fill progressively, and track received/total so the
  // view can show progress. The REST payload stays authoritative — if a
  // chunk is dropped, the next datePayload refetch fills the gap.
  if (type === "metadataChunk" && date) {
    mergeMetadataChunk(qc, location, camera, date, msg);
    return;
  }
  if (type === "metadataComplete" && date) {
    completeMetadataStream(
      qc,
      location,
      camera,
      date,
      msg.total ?? 0,
      msg.etag,
    );
    return;
  }
  if (type === "metadataDelta" && date) {
    applyMetadataDelta(qc, location, camera, date, msg);
    return;
  }

  switch (type) {
    case "channelData":
    case "perDay":
    case "metadata":
      if (date) {
        qc.invalidateQueries({
          queryKey: queryKeys.datePayload(location, camera, date),
        });
        // The REST metadata query is normally disabled (the stream delivers
        // metadata; see useMetadata), so this only matters when it is the
        // active path — then a rewrite must refetch. Harmless otherwise.
        qc.invalidateQueries({
          queryKey: queryKeys.metadata(location, camera, date),
        });
      }
      // The calendar is refreshed on calendarUpdate alone: the store
      // publishes one when a date first appears, so refetching the (large,
      // per-date-counts) calendar on every exposure buys nothing.
      break;
    case "nightReport":
      if (date) {
        qc.invalidateQueries({
          queryKey: queryKeys.nightReport(location, camera, date),
        });
      }
      break;
    case "dayChange":
      qc.invalidateQueries({ queryKey: queryKeys.calendar(location, camera) });
      break;
    case "calendarUpdate":
      // A date was added or pruned by the store (e.g. the full sweep dropped a
      // stale warm-start date). Refresh the calendar so the picker reflects it;
      // also drop the (now possibly gone) date's payload so a stale grid clears.
      qc.invalidateQueries({ queryKey: queryKeys.calendar(location, camera) });
      if (date) {
        qc.invalidateQueries({
          queryKey: queryKeys.datePayload(location, camera, date),
        });
      }
      break;
  }
}

export type Metadata = Record<string, Record<string, unknown>>;

/** Drop the accumulated WS metadata stream for a (loc, cam, date).
 *
 *  Called when a fresh REST metadata document lands: that document is complete
 *  as of its fetch time, so anything accumulated from the stream before then
 *  is redundant — and keeping it would resurrect rows deleted server-side
 *  (the slot is otherwise only ever added to). Chunks arriving afterwards
 *  re-accumulate on top as normal. */
export function resetMetadataStream(
  qc: QueryClient,
  location: string,
  camera: string,
  date: string,
): void {
  qc.setQueryData<Metadata>(
    queryKeys.metadataStream(location, camera, date),
    {},
  );
}

/** Merge one streamed metadata chunk into the shown rows + progress. */
function mergeMetadataChunk(
  qc: QueryClient,
  location: string,
  camera: string,
  date: string,
  msg: ServerMessage,
): void {
  const chunk = (msg.data ?? {}) as Metadata;
  const pendingKey = queryKeys.metadataPending(location, camera, date);
  const progressKey = queryKeys.metadataProgress(location, camera, date);

  // seq 0 opens a stream (first load, or a re-stream after the file was
  // rewritten): start its accumulator and chunk count afresh. The shown rows
  // are left alone so a re-stream fills in over them rather than blanking.
  if (msg.seq === 0) {
    qc.setQueryData<Metadata>(pendingKey, {});
    qc.setQueryData<MetadataProgress>(progressKey, { rows: 0, chunks: 0 });
    qc.setQueryData<MetadataStreamStatus>(
      queryKeys.metadataStreamStatus(location, camera, date),
      "streaming",
    );
  }
  qc.setQueryData<Metadata>(pendingKey, (prev) => ({
    ...(prev ?? {}),
    ...chunk,
  }));

  // Also straight into the shown slot, so cells fill progressively.
  const streamKey = queryKeys.metadataStream(location, camera, date);
  const next = qc.setQueryData<Metadata>(streamKey, (prev) => ({
    ...(prev ?? {}),
    ...chunk,
  }));
  const rows = next ? Object.keys(next).length : Object.keys(chunk).length;
  const chunks =
    (qc.getQueryData<MetadataProgress>(progressKey)?.chunks ?? 0) + 1;
  qc.setQueryData<MetadataProgress>(progressKey, { rows, chunks });

  debugLog("liveQuery.metadataChunk", {
    camera,
    date,
    seq: msg.seq,
    rowsInChunk: Object.keys(chunk).length,
    rowsTotal: rows,
  });
}

/** Close a stream: promote its rows if every chunk arrived, else flag it. */
function completeMetadataStream(
  qc: QueryClient,
  location: string,
  camera: string,
  date: string,
  total: number,
  etag: string | undefined,
): void {
  const progressKey = queryKeys.metadataProgress(location, camera, date);
  const pendingKey = queryKeys.metadataPending(location, camera, date);
  const chunks = qc.getQueryData<MetadataProgress>(progressKey)?.chunks ?? 0;
  const complete = chunks >= total;
  if (complete) {
    // This stream is the whole document as of now: replace the shown rows
    // with exactly it, so a row deleted server-side doesn't linger.
    qc.setQueryData<Metadata>(
      queryKeys.metadataStream(location, camera, date),
      qc.getQueryData<Metadata>(pendingKey) ?? {},
    );
  }
  qc.setQueryData<MetadataStreamStatus>(
    queryKeys.metadataStreamStatus(location, camera, date),
    complete ? "complete" : "incomplete",
  );
  // Only a complete document is a version we can be brought forward from.
  qc.setQueryData<string | null>(
    queryKeys.metadataEtag(location, camera, date),
    complete ? (etag ?? null) : null,
  );
  qc.setQueryData<Metadata>(pendingKey, {});
  qc.setQueryData<MetadataProgress | null>(progressKey, null);
  debugLog("liveQuery.metadataComplete", {
    camera,
    date,
    chunks,
    total,
    complete,
  });
}

/** Bring the shown rows forward by a server-computed difference. */
function applyMetadataDelta(
  qc: QueryClient,
  location: string,
  camera: string,
  date: string,
  msg: ServerMessage,
): void {
  const rows = (msg.data?.rows ?? {}) as Metadata;
  const removed = (msg.data?.removed ?? []) as string[];
  qc.setQueryData<Metadata>(
    queryKeys.metadataStream(location, camera, date),
    (prev) => {
      const next = { ...(prev ?? {}), ...rows };
      for (const seq of removed) delete next[seq];
      return next;
    },
  );
  qc.setQueryData<MetadataStreamStatus>(
    queryKeys.metadataStreamStatus(location, camera, date),
    "complete",
  );
  qc.setQueryData<string | null>(
    queryKeys.metadataEtag(location, camera, date),
    msg.etag ?? null,
  );
  debugLog("liveQuery.metadataDelta", {
    camera,
    date,
    rows: Object.keys(rows).length,
    removed: removed.length,
    etag: msg.etag,
  });
}

/** The metadata version the shown rows represent, for a refresh request. */
export function metadataEtag(
  qc: QueryClient,
  location: string,
  camera: string,
  date: string,
): string | null {
  return (
    qc.getQueryData<string | null>(
      queryKeys.metadataEtag(location, camera, date),
    ) ?? null
  );
}

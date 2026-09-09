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
  channel?: string;
  date?: string;
  data?: Record<string, unknown>;
  // Metadata streaming progress (metadataChunk / metadataComplete).
  seq?: number;
  total?: number;
}

// Query key builders shared with the views (Phase 5 imports these too).
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
  // applyLiveMessage, read by CameraTable to show a running row count while
  // metadata streams in. null once complete (or never started).
  metadataProgress: (loc: string, cam: string, date: string) =>
    ["metadataProgress", loc, cam, date] as const,
  // Accumulated streamed metadata for a (loc, cam, date). Kept separate from
  // the REST date payload so streamed rows are never lost to the payload's
  // load lifecycle; CameraTable merges the two at render time.
  metadataStream: (loc: string, cam: string, date: string) =>
    ["metadataStream", loc, cam, date] as const,
  // Site-wide live state pushed over the WS. Both are written by
  // applyLiveMessage via setQueryData (snapshot on subscribe, then deltas)
  // and read by the Detectors / Admin views with an inert cache-only queryFn.
  detectorStatus: () => ["detectorStatus"] as const,
  controlReadback: () => ["controlReadback"] as const,
};

/** Progress of an in-flight metadata stream. The total isn't known until the
 *  stream ends (it parses incrementally), so we report rows received so far. */
export interface MetadataProgress {
  rows: number;
}

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
    qc.setQueryData(
      queryKeys.metadataProgress(location, camera, date),
      null,
    );
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
        // A metadata.json update isn't reflected in the date payload — the
        // REST metadata query is a separate cache entry (read by the table and
        // the single-channel view), so invalidate it too or new seqs' rows
        // never land. channelData can land slightly ahead of the metadata
        // write, so refetch on it as well; the query dedupes.
        qc.invalidateQueries({
          queryKey: queryKeys.metadata(location, camera, date),
        });
      }
      // A new date can extend the calendar.
      qc.invalidateQueries({ queryKey: queryKeys.calendar(location, camera) });
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

type Metadata = Record<string, Record<string, unknown>>;

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

/** Merge one streamed metadata chunk into the date payload + progress. */
function mergeMetadataChunk(
  qc: QueryClient,
  location: string,
  camera: string,
  date: string,
  msg: ServerMessage,
): void {
  const chunk = (msg.data ?? {}) as Metadata;

  // Accumulate into the dedicated stream slot (never lost; merged at render).
  const streamKey = queryKeys.metadataStream(location, camera, date);
  const next = qc.setQueryData<Metadata>(streamKey, (prev) => ({
    ...(prev ?? {}),
    ...chunk,
  }));
  const rows = next ? Object.keys(next).length : Object.keys(chunk).length;

  qc.setQueryData<MetadataProgress>(
    queryKeys.metadataProgress(location, camera, date),
    { rows },
  );

  debugLog("liveQuery.metadataChunk", {
    camera,
    date,
    seq: msg.seq,
    rowsInChunk: Object.keys(chunk).length,
    rowsTotal: rows,
  });
}

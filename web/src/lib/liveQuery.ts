// Bridge WebSocket messages to TanStack Query cache. A live ServerMessage
// names the (location, camera, date) that changed; we invalidate the
// matching query keys so the affected view refetches (or, where the message
// carries data, it could setQueryData directly). Keeping it invalidation-
// based is simplest and correct: the REST endpoint is the formatter.

import type { QueryClient } from "@tanstack/react-query";
import type { DatePayload } from "./types";
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
  // Progress of the WS metadata stream for a (loc, cam, date). Written by
  // applyLiveMessage, read by CameraTable to show "metadata N/total". null
  // once complete (or never started).
  metadataProgress: (loc: string, cam: string, date: string) =>
    ["metadataProgress", loc, cam, date] as const,
};

/** Progress of an in-flight metadata stream. */
export interface MetadataProgress {
  received: number;
  total: number;
}

/** Apply a live message by invalidating the affected cached queries. */
export function applyLiveMessage(qc: QueryClient, msg: ServerMessage): void {
  const { type, location, camera, date } = msg;
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
  }
}

type Metadata = Record<string, Record<string, unknown>>;

/** Merge one streamed metadata chunk into the date payload + progress. */
function mergeMetadataChunk(
  qc: QueryClient,
  location: string,
  camera: string,
  date: string,
  msg: ServerMessage,
): void {
  const chunk = (msg.data ?? {}) as Metadata;

  let merged = false;
  qc.setQueryData<DatePayload>(
    queryKeys.datePayload(location, camera, date),
    (prev) => {
      if (!prev) return prev; // No payload yet; REST fetch will carry metadata.
      merged = true;
      return { ...prev, metadata: { ...prev.metadata, ...chunk } };
    },
  );
  debugLog("liveQuery.metadataChunk", {
    camera,
    date,
    seq: msg.seq,
    total: msg.total,
    rows: Object.keys(chunk).length,
    mergedIntoPayload: merged,
  });

  if (typeof msg.seq === "number" && typeof msg.total === "number") {
    qc.setQueryData<MetadataProgress>(
      queryKeys.metadataProgress(location, camera, date),
      { received: msg.seq + 1, total: msg.total },
    );
  }
}

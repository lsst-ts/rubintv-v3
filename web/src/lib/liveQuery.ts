// Bridge WebSocket messages to TanStack Query cache. A live ServerMessage
// names the (location, camera, date) that changed; we invalidate the
// matching query keys so the affected view refetches (or, where the message
// carries data, it could setQueryData directly). Keeping it invalidation-
// based is simplest and correct: the REST endpoint is the formatter.

import type { QueryClient } from "@tanstack/react-query";
import { metadataKey, metadataRewritten } from "./metadata";

export interface ServerMessage {
  type: string;
  location?: string;
  camera?: string;
  date?: string;
  data?: Record<string, unknown>;
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
  // A date's metadata, with the version it is. Fetched and brought forward
  // by lib/metadata, apart from the date payload so the grid never waits
  // on it.
  metadata: metadataKey,
  // Site-wide live state pushed over the WS. Both are written by
  // applyLiveMessage via setQueryData (snapshot on subscribe, then deltas)
  // and read by the Detectors / Admin views with an inert cache-only queryFn.
  detectorStatus: () => ["detectorStatus"] as const,
  controlReadback: () => ["controlReadback"] as const,
};

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

  switch (type) {
    case "metadata":
      // The date's metadata.json appeared or was rewritten. Only the
      // metadata is fetched: the date payload carries none (see
      // DatePayload), so refetching it too cost each open page a whole
      // payload per rewrite, and the file is rewritten as each exposure's
      // rows land, often in the same poll as its images.
      if (date) metadataRewritten(qc, location, camera, date);
      break;
    case "channelData":
    case "perDay":
      if (date) {
        qc.invalidateQueries({
          queryKey: queryKeys.datePayload(location, camera, date),
        });
      }
      // The calendar is otherwise refreshed on calendarUpdate alone: the store
      // publishes one when a date first appears, so refetching the (large,
      // per-date-counts) calendar on every exposure buys nothing. A per-day
      // artifact is the exception — it usually lands on a date that already
      // exists, yet adds a night to the calendar's per_day_dates, which the
      // per-day viewer's live mode and date picker read. It arrives about
      // once a night, so it's cheap.
      if (type === "perDay") {
        qc.invalidateQueries({ queryKey: queryKeys.calendar(location, camera) });
      }
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

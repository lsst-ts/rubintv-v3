// Bridge WebSocket messages to TanStack Query cache. A live ServerMessage
// names the (location, camera, date) that changed; we invalidate the
// matching query keys so the affected view refetches (or, where the message
// carries data, it could setQueryData directly). Keeping it invalidation-
// based is simplest and correct: the REST endpoint is the formatter.

import type { QueryClient } from "@tanstack/react-query";

export interface ServerMessage {
  type: string;
  location?: string;
  camera?: string;
  channel?: string;
  date?: string;
  data?: Record<string, unknown>;
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
};

/** Apply a live message by invalidating the affected cached queries. */
export function applyLiveMessage(qc: QueryClient, msg: ServerMessage): void {
  const { type, location, camera, date } = msg;
  if (!location || !camera) return;

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

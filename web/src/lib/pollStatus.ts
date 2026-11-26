import type { LocationStatus, StatusResponse } from "./types";

// The server's S3 poll as one page should report it.
//
// The server polls each location with loops of its own, so a location whose
// bucket can't be reached fails alone: the others go on polling, and say
// so. A page on a location reports that location's poll. A page with none
// in view (the Status page's header) reports the server's summary of them
// all, which is the worst of each: unreachable if any is.
export type PollStatus = Pick<
  LocationStatus,
  | "s3_healthy"
  | "s3_slow"
  | "s3_last_cycle_seconds"
  | "poll_stalled"
  | "last_poll_age_seconds"
  | "historical_loading"
>;

// `locations` is absent from a server older than this page, which a tab
// left open across a deploy can be talking to; the summary stands in.
export function pollFor(data: StatusResponse, location?: string): PollStatus {
  const own = location
    ? data.locations?.find((l) => l.location === location)
    : undefined;
  return own ?? data;
}

// The titles of the locations in some state, to say which the summary is of.
export function locationsWhere(
  data: StatusResponse,
  test: (l: LocationStatus) => boolean,
): string[] {
  return (data.locations ?? []).filter(test).map((l) => l.location_title);
}

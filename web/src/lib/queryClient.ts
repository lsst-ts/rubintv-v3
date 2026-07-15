import { QueryClient } from "@tanstack/react-query";

// Centralised TanStack Query config. The date-tiered staleTime strategy
// (Appendix A of the design doc) lives here so every view shares it.
//
// Historical data is MUTABLE — yesterday churns as analysis backlogs clear,
// and older dates can still gain/lose fields — so nothing is cached forever
// except static config. stale-while-revalidate everywhere: show cached data
// instantly, refetch in the background.

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * The current observing day (day_obs) as an ISO `YYYY-MM-DD` string.
 *
 * The observatory rolls the date at noon UTC (the observing day runs noon
 * UTC to noon UTC), so the current day_obs is `now − 12h` in UTC. Mirrors the
 * server's `rubintv/data/dayobs.py:get_current_day_obs` — keep the two in step.
 */
export function currentDayObs(now: Date = new Date()): string {
  return new Date(now.getTime() - 12 * 60 * MINUTE).toISOString().slice(0, 10);
}

/**
 * Freshness of a camera, for the location/sidebar status dot:
 *   - "offline" — the camera is disabled in config (online === false).
 *   - "fresh"   — online and has data for the current observing day.
 *   - "stale"   — online, has data, but its newest is from an earlier day.
 *   - "nodata"  — online but has never had any data (latest_date is null).
 *
 * "stale" and "nodata" are kept distinct: a stale camera has fallen behind
 * but has history to show, whereas a nodata camera has nothing at all. The
 * API already tells them apart — `latest_date` is a concrete YYYY-MM-DD for
 * the former and null for the latter.
 *
 * `latestDate` is the camera's most recent day with data (YYYY-MM-DD) from the
 * location payload, or null/undefined when it has none.
 */
export type CameraDataState = "offline" | "fresh" | "stale" | "nodata";

export function cameraDataState(
  online: boolean,
  latestDate: string | null | undefined,
  now: Date = new Date(),
): CameraDataState {
  if (!online) return "offline";
  if (!latestDate) return "nodata";
  return latestDate === currentDayObs(now) ? "fresh" : "stale";
}

/** staleTime for camera/metadata data, by how many days ago the date is.
 *
 * "days ago" is measured in OBSERVING-day (day_obs) space, not calendar-UTC:
 * the observing day rolls at noon UTC, so the live day_obs must map to
 * daysAgo 0 for the whole night. Comparing the raw UTC-midnight timestamps
 * against wall-clock `now` put the live night (00:00Z onward) at daysAgo 1 —
 * the "yesterday" tier — for the bulk of observing. Both sides are converted
 * to a day_obs date (`now − 12h`, and the passed date treated as its day_obs)
 * before differencing, so the boundary lines up. `date` is a UTC-midnight Date
 * parsed from a YYYY-MM-DD day_obs string (how every caller builds it). */
export function staleTimeForDate(date: Date, now: Date = new Date()): number {
  // The date arg is already a day_obs (UTC midnight of the observing day); the
  // current day_obs is now shifted back 12h. Difference their UTC-midnight
  // timestamps to get whole observing-days elapsed.
  const nowObs = new Date(now.getTime() - 12 * 60 * MINUTE);
  const nowMidnight = Date.UTC(
    nowObs.getUTCFullYear(),
    nowObs.getUTCMonth(),
    nowObs.getUTCDate(),
  );
  const daysAgo = Math.round((nowMidnight - date.getTime()) / (24 * 60 * MINUTE));
  if (daysAgo <= 0) return 0; // today: WebSocket-driven
  if (daysAgo <= 1) return 30 * SECOND; // yesterday: churns
  if (daysAgo <= 7) return 2 * MINUTE; // last week
  return 5 * MINUTE; // older
}

export const STALE = {
  config: Infinity, // locations/cameras: static
  calendar: 5 * MINUTE,
  nightReport: 2 * MINUTE,
} as const;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Always show stale while revalidating; refetch on focus is noisy
        // for an always-on summit display, so disable it.
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

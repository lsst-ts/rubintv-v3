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
 *   - "stale"   — online but its newest data is from an earlier day (or none).
 *
 * `latestDate` is the camera's most recent day with data (YYYY-MM-DD) from the
 * location payload, or null/undefined when it has none.
 */
export type CameraDataState = "offline" | "fresh" | "stale";

export function cameraDataState(
  online: boolean,
  latestDate: string | null | undefined,
  now: Date = new Date(),
): CameraDataState {
  if (!online) return "offline";
  return latestDate === currentDayObs(now) ? "fresh" : "stale";
}

/** staleTime for camera/metadata data, by how many days ago the date is. */
export function staleTimeForDate(date: Date, now: Date = new Date()): number {
  const daysAgo = Math.floor((now.getTime() - date.getTime()) / (24 * 60 * MINUTE));
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

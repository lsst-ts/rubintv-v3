import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

// When the server last polled the S3 bucket successfully: the moment today's
// data on a page is "as of".
//
// The server reports it as an age (seconds before its answer), and this
// places it on the tab's own clock, so the two clocks needn't agree. The
// status is polled every 5 seconds, so the time moves in steps of about
// that; what it is compared with (see useNow) ticks every second, so a time
// that has stopped moving is seen to age without waiting on a poll, and
// keeps ageing while the polls themselves fail.

// How old the last poll may be before a page calls its data stale. A healthy
// cycle is a second or so and a slow one under ten, on top of the 5 seconds
// between status polls; a cycle that can't reach S3 takes 20 to fail.
export const STALE_AFTER_MS = 30_000;

export function useLastPoll(): number | null {
  const { data, dataUpdatedAt } = useQuery({
    queryKey: ["status"],
    queryFn: () => api.status(),
    refetchInterval: 5000,
  });
  const age = data?.last_poll_age_seconds;
  return age == null ? null : dataUpdatedAt - age * 1000;
}

// The tab's clock, re-read every `intervalMs`.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const pad = (n: number) => String(n).padStart(2, "0");

// HH:MM:SS in UTC.
export function utcClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// A rough age in words: "45 s", "12 min", "3 h".
export function roughAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

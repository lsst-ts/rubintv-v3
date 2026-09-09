import { useEffect, useState } from "react";

// Header clocks: a live UTC wall clock, and — for cameras that have a
// time_since_clock configured, on the current (live) date only — a "time since
// last image" clock derived from the newest exposure's "Date begin" timestamp.
// Both tick once a second. Mirrors the design's LiveStatusPill.

const pad = (n: number) => String(n).padStart(2, "0");

function utcNow(now: number): string {
  const d = new Date(now);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Elapsed HH:MM:SS since `from` (ms), or null if `from` is unknown/invalid.
function elapsed(now: number, from: number | null): string | null {
  if (from === null) return null;
  const s = Math.max(0, Math.floor((now - from) / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

interface Props {
  // Label for the time-since clock (camera's time_since_clock.label), or null
  // when the camera has no such clock / it shouldn't show (e.g. historical day).
  sinceLabel: string | null;
  // The latest exposure's "Date begin" timestamp string, if available.
  lastImage: string | null;
}

export function LiveClocks({ sinceLabel, lastImage }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // "Date begin" is an ISO-ish UTC timestamp (e.g. 2026-05-01T10:11:51.738).
  // Parse it as UTC; bare times with no date can't be anchored, so skip those.
  const lastMs = (() => {
    if (!lastImage) return null;
    const s = String(lastImage).trim();
    if (!/\d{4}-\d{2}-\d{2}/.test(s)) return null;
    const ms = Date.parse(s.endsWith("Z") || s.includes("+") ? s : `${s}Z`);
    return Number.isNaN(ms) ? null : ms;
  })();

  const since = sinceLabel ? elapsed(now, lastMs) : null;

  return (
    <span className="status-pill" role="status">
      <span className="clocks">
        <span className="clock-label">UTC</span>
        <span className="clock-time">{utcNow(now)}</span>
        {sinceLabel && since !== null && (
          <>
            <span className="clock-label">{sinceLabel}</span>
            <span className="clock-time">{since}</span>
          </>
        )}
      </span>
    </span>
  );
}

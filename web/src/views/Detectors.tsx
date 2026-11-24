import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { roughAge, useNow } from "../lib/lastPoll";
import { queryKeys } from "../lib/liveQuery";
import { useLive, useLiveTopic } from "../lib/LiveContext";
import {
  unansweredFor,
  unansweredSince,
  useRedisLink,
  utcWhen,
  type RedisLink,
} from "../lib/redisLink";
import { usePageTitle } from "../lib/usePageTitle";
import { AdminAccessNote } from "../components/AdminAccessNote";
import { ConfirmButton } from "../components/ConfirmButton";
import {
  createPlaceholders,
  getStatusClass,
  getStatusColor,
  type SetPayload,
  type WorkerStatus,
} from "../lib/detectorUtils";
import type { DetectorStatus } from "../lib/types";
import detectorMap from "../data/detectorMap.json";
import cwfsMap from "../data/cwfsMap.json";

// Site-wide cluster worker status ("Cluster Status"), live from Redis streams
// via the detectors topic. Layout mirrors the original app: two imaging sets +
// SFM Step 1b, four CWFS sets + AOS Step 1b, a Backlog row, and an Other Queues
// table. The geometric sets render their workers as focal-plane polygons from
// the corner maps; the step1b/backlog sets render a simple cell grid.
//
// The section structure (titles, which map, grouping) is hardcoded to match the
// original; the redis_detectors config supplies the live data per set name.

// Corners are [x, y]; the JSON imports them as number[], so keep the type loose
// to avoid tuple-vs-array friction with the imported maps.
interface DetectorCorners {
  corners: {
    upperLeft: number[];
    upperRight: number[];
    lowerLeft: number[];
    lowerRight: number[];
  };
}
type DetectorMap = Record<string, DetectorCorners>;

// When each set was last written (on the tab's clock), by set name: pushed
// into the cache with the status itself (see applyLiveMessage), and read
// from there like it.
const NONE_WRITTEN: Record<string, number> = {};
function useWritten(): Record<string, number> {
  const qc = useQueryClient();
  const key = queryKeys.detectorWritten();
  const { data } = useQuery<Record<string, number>>({
    queryKey: key,
    queryFn: () => qc.getQueryData<Record<string, number>>(key) ?? {},
    staleTime: Infinity,
  });
  return data ?? NONE_WRITTEN;
}

const SETS = {
  sfmSet0: "Imaging Worker Set 1",
  sfmSet1: "Imaging Worker Set 2",
  aosSet0: "CWFS Worker Set 1",
  aosSet1: "CWFS Worker Set 2",
  aosSet2: "CWFS Worker Set 3",
  aosSet3: "CWFS Worker Set 4",
} as const;

export function Detectors() {
  usePageTitle("Cluster Status");
  const qc = useQueryClient();
  // Site-wide subscription (empty location keys the detectors|| topic).
  useLiveTopic({ topic: "detectors", location: "" });

  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  // Live status pushed into the cache by applyLiveMessage; inert cache-only
  // queryFn so it never clobbers a value the WS just wrote.
  const statusKey = queryKeys.detectorStatus();
  const { data } = useQuery<DetectorStatus>({
    queryKey: statusKey,
    queryFn: () => qc.getQueryData<DetectorStatus>(statusKey) ?? {},
    staleTime: Infinity,
  });
  const sets = data ?? {};
  const hasAny = Object.keys(sets).length > 0;

  // How fresh that is. The cluster writes a set only when it changes, and
  // the page keeps the last picture it was sent, so without these a picture
  // from before Redis, the server or this tab's connection went away reads
  // as the cluster now.
  const written = useWritten();
  const link = useRedisLink();
  const { disconnected } = useLive();
  const redisLost = link !== undefined && link.configured && !link.connected;
  const frozen = hasAny && (disconnected || redisLost);

  // Whether to offer the (site-admin gated) restart controls. The endpoint is
  // server-gated regardless; this just hides buttons a non-admin can't use.
  const { data: adminStatus } = useQuery({
    queryKey: ["adminStatus"],
    queryFn: api.adminStatus,
  });
  const admin = adminStatus?.is_admin ?? false;

  const restart = async (name: string, title: string) => {
    try {
      const res = await api.restartWorkers(name);
      setFeedback({ ok: res.ok, text: `${title}: ${res.detail || "restarted"}` });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      setFeedback({ ok: false, text: `${title} restart failed — ${msg}` });
    }
  };

  return (
    <section className={"cluster-status" + (frozen ? " is-frozen" : "")}>
      <h1>Cluster Status</h1>
      {adminStatus && !admin && (
        <AdminAccessNote
          user={adminStatus.user ?? null}
          consequence="the worker restart buttons are hidden"
        />
      )}
      <Freshness
        link={link}
        hasAny={hasAny}
        disconnected={disconnected}
        written={written}
      />
      {feedback && (
        <p
          role="status"
          className={feedback.ok ? "admin-feedback ok" : "admin-feedback err"}
        >
          {feedback.text}
        </p>
      )}

      <Legend />

      <div className="main-detectors">
        <CanvasSection
          name="sfmSet0"
          title={SETS.sfmSet0}
          map={detectorMap as DetectorMap}
          payload={sets.sfmSet0}
          size="large"
          onRestart={restart}
          admin={admin}
        />
        <CanvasSection
          name="sfmSet1"
          title={SETS.sfmSet1}
          map={detectorMap as DetectorMap}
          payload={sets.sfmSet1}
          size="large"
          onRestart={restart}
          admin={admin}
        />
        <CellsSection
          name="sfmStep1b"
          title="SFM Step 1b"
          payload={sets.sfmStep1b}
          fallbackCount={8}
          onRestart={restart}
          admin={admin}
        />
      </div>

      <div className="aos-detectors">
        <CanvasSection
          name="aosSet0"
          title={SETS.aosSet0}
          map={cwfsMap as DetectorMap}
          payload={sets.aosSet0}
          size="small"
          onRestart={restart}
          admin={admin}
        />
        <CanvasSection
          name="aosSet1"
          title={SETS.aosSet1}
          map={cwfsMap as DetectorMap}
          payload={sets.aosSet1}
          size="small"
          onRestart={restart}
          admin={admin}
        />
        <CanvasSection
          name="aosSet2"
          title={SETS.aosSet2}
          map={cwfsMap as DetectorMap}
          payload={sets.aosSet2}
          size="small"
          onRestart={restart}
          admin={admin}
        />
        <CanvasSection
          name="aosSet3"
          title={SETS.aosSet3}
          map={cwfsMap as DetectorMap}
          payload={sets.aosSet3}
          size="small"
          onRestart={restart}
          admin={admin}
        />
        <CellsSection
          name="aosStep1b"
          title="AOS Step 1b"
          payload={sets.aosStep1b}
          fallbackCount={8}
          onRestart={restart}
          admin={admin}
        />
      </div>

      <div className="bottom-row">
        <div className="spareworkers-section">
          <div className="detector-head">
            <h3>Backlog Workers</h3>
            <SetAge name="spareWorkers" />
          </div>
          <Cells payload={sets.spareWorkers} fallbackCount={4} prefix="spareworkers" />
          <RestartButton name="spareWorkers" title="Backlog Workers" onRestart={restart} admin={admin} />
        </div>
        <OtherQueues payload={sets.otherQueues} />
      </div>
    </section>
  );
}

// What the picture below is worth, in a line above it.
//
// Quiet while all is well: the newest change of any set, as a time. Amber
// when the picture is no longer being kept up (the server has lost Redis, or
// this tab the server), with since when. The sentence in the live region
// holds still while that lasts; the age that grows is beside it, outside.
function Freshness({
  link,
  hasAny,
  disconnected,
  written,
}: {
  link: RedisLink | undefined;
  hasAny: boolean;
  disconnected: boolean;
  written: Record<string, number>;
}) {
  const now = useNow();
  if (disconnected && hasAny) {
    return (
      <p className="cluster-freshness is-stale">
        <span role="alert">
          This tab has lost its connection to the server, so the picture below
          is not being updated.
        </span>
      </p>
    );
  }
  if (!link) {
    return hasAny ? null : <p className="skeleton">Awaiting cluster status.</p>;
  }
  if (!link.configured) {
    return (
      <p className="skeleton">
        Cluster status is read from Redis, which is not configured for this
        deployment.
      </p>
    );
  }
  if (!link.connected) {
    const age = unansweredFor(link, now);
    return (
      <p className="cluster-freshness is-stale">
        <span role="alert">
          The server has had no answer from Redis {unansweredSince(link, now)}
          {hasAny
            ? ", so the picture below is the cluster as it was then."
            : ", so there is no cluster status to show."}{" "}
          It keeps trying.
        </span>
        {age !== null && <span> ({age})</span>}
      </p>
    );
  }
  if (!hasAny) {
    return (
      <p className="skeleton">
        Awaiting cluster status: Redis is answering, but holds none yet.
      </p>
    );
  }
  const times = Object.values(written);
  if (times.length === 0) return null;
  const newest = Math.max(...times);
  return (
    <p
      className="cluster-freshness"
      title="When the cluster last wrote any set. It writes one only when it changes, so this stands still while the cluster is quiet, and also if whatever writes it has stopped."
    >
      Last change {utcWhen(newest, now)} ({roughAge(now - newest)} ago)
    </p>
  );
}

// How long ago a set was last written, beside its title. An old one is a
// quiet set or a writer that has stopped: nothing in the data tells them
// apart, so it is shown plainly and left to the reader.
function SetAge({ name }: { name: string }) {
  const at = useWritten()[name];
  const now = useNow();
  if (at === undefined) return null;
  return (
    <span
      className="detector-age"
      title={`Last written at ${utcWhen(at, now)}. A set is written only when it changes.`}
    >
      {roughAge(now - at)} ago
    </span>
  );
}

const LEGEND: { cls: string; label: string }[] = [
  { cls: "status-free", label: "Free" },
  { cls: "status-busy", label: "Busy" },
  { cls: "status-queued", label: "Queued" },
  { cls: "status-restarting", label: "Restarting" },
  { cls: "status-guest", label: "Guest payload" },
  { cls: "status-missing", label: "Missing" },
];

function Legend() {
  return (
    <div className="legend">
      <div className="legend-items">
        {LEGEND.map(({ cls, label }) => (
          <div key={cls} className="legend-item">
            <div className={`legend-color ${cls}`} />
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Merge a set's reported workers over numWorkers placeholders, so a set that
// advertises a count but lacks per-worker detail still shows the right cells.
function workersOf(payload: SetPayload | undefined): Record<string, WorkerStatus> {
  const workers = payload?.workers ?? {};
  if (payload?.numWorkers && payload.numWorkers > 0) {
    return { ...createPlaceholders(payload.numWorkers), ...workers };
  }
  return workers;
}

interface SectionProps {
  name: string;
  title: string;
  payload: SetPayload | undefined;
  onRestart: (name: string, title: string) => void | Promise<void>;
  admin: boolean;
}

function CanvasSection({
  name,
  title,
  map,
  payload,
  size,
  onRestart,
  admin,
}: SectionProps & { map: DetectorMap; size: "large" | "small" }) {
  return (
    <div className={`detector-section detector-section-${size}`}>
      <div className="detector-head">
        <h2 className="detector-title">{title}</h2>
        <SetAge name={name} />
      </div>
      <DetectorCanvas map={map} workers={workersOf(payload)} />
      <RestartButton name={name} title={title} onRestart={onRestart} admin={admin} />
    </div>
  );
}

function CellsSection({
  name,
  title,
  payload,
  fallbackCount,
  onRestart,
  admin,
}: SectionProps & { fallbackCount: number }) {
  return (
    <div className="step1b-section">
      <div className="detector-head">
        <h2 className="detector-title">{title}</h2>
        <SetAge name={name} />
      </div>
      <div className="step1b-canvas">
        <Cells payload={payload} fallbackCount={fallbackCount} prefix="step1b" />
      </div>
      <RestartButton name={name} title={title} onRestart={onRestart} admin={admin} />
    </div>
  );
}

function Cells({
  payload,
  fallbackCount,
  prefix,
}: {
  payload: SetPayload | undefined;
  fallbackCount: number;
  prefix: string;
}) {
  const workers =
    payload && (payload.workers || payload.numWorkers)
      ? workersOf(payload)
      : createPlaceholders(fallbackCount);
  return (
    <div className={`${prefix}-cells`}>
      {Object.entries(workers).map(([i, status]) => (
        <Cell key={`${prefix}-${i}`} status={status} />
      ))}
    </div>
  );
}

function Cell({ status }: { status: WorkerStatus }) {
  return (
    <div className={`detector-cell ${getStatusClass(status.status)}`}>
      {status.status === "queued" && (
        <div className="detector-cell-content queue-length">{status.queue_length}</div>
      )}
    </div>
  );
}

function RestartButton({
  name,
  title,
  onRestart,
  admin,
}: {
  name: string;
  title: string;
  onRestart: (name: string, title: string) => void | Promise<void>;
  admin: boolean;
}) {
  // The restart endpoint is site-admin gated server-side; hide the control from
  // non-admins so they aren't offered an action that would only 403.
  if (!admin) return null;
  return (
    <ConfirmButton
      label="Restart Workers"
      confirmLabel="Confirm restart"
      danger
      onConfirm={() => onRestart(name, title)}
    />
  );
}

function OtherQueues({ payload }: { payload: SetPayload | undefined }) {
  const text = payload?.text ?? {};
  const rows = Object.entries(text)
    .filter(([, v]) => String(v) !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="other-queues-section">
      <div className="other-queues">
        <div className="detector-head">
          <h3>Other Queues</h3>
          <SetAge name="otherQueues" />
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Queue Name</th>
              <th>Queue Length</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, value]) => (
              <tr key={key}>
                <td>{key}</td>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Draws each detector cell as a polygon from its corner map, scaled to fit the
// (square) canvas. Ported from the original DetectorCanvas; redraws on status
// change and container resize.
function DetectorCanvas({
  map,
  workers,
}: {
  map: DetectorMap;
  workers: Record<string, WorkerStatus>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize(el.getBoundingClientRect().width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Bounds of the corner map (stable for a given map).
  const bounds = useMemo(() => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const det of Object.values(map)) {
      for (const corner of Object.values(det.corners)) {
        minX = Math.min(minX, corner[0]);
        maxX = Math.max(maxX, corner[0]);
        minY = Math.min(minY, corner[1]);
        maxY = Math.max(maxY, corner[1]);
      }
    }
    return { minX, maxX, minY, maxY };
  }, [map]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const padding = size * 0.1;
    const { minX, maxX, minY, maxY } = bounds;
    const scale = Math.min(
      (size - 2 * padding) / (maxX - minX),
      (size - 2 * padding) / (maxY - minY),
    );
    const toX = (x: number) => (x - minX) * scale + padding;
    const toY = (y: number) => (maxY - y) * scale + padding;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#374151";
    ctx.lineWidth = dpr;

    for (const [id, det] of Object.entries(map)) {
      const status = workers[id] ?? { status: "unknown", queue_length: 0 };
      const { upperLeft, upperRight, lowerLeft, lowerRight } = det.corners;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(toX(upperLeft[0]), toY(upperLeft[1]));
      ctx.lineTo(toX(upperRight[0]), toY(upperRight[1]));
      ctx.lineTo(toX(lowerRight[0]), toY(lowerRight[1]));
      ctx.lineTo(toX(lowerLeft[0]), toY(lowerLeft[1]));
      ctx.closePath();
      ctx.fillStyle = getStatusColor(status.status);
      ctx.fill();
      ctx.stroke();

      ctx.globalAlpha = 1;
      if (status.status === "queued" && status.queue_length) {
        const cx = toX((upperLeft[0] + lowerRight[0]) / 2);
        const cy = toY((upperLeft[1] + lowerRight[1]) / 2);
        ctx.fillStyle = "white";
        ctx.font = "bold 14px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(status.queue_length), cx, cy);
      }
    }
  }, [map, workers, size, bounds]);

  return (
    <div ref={containerRef} className="detector-canvas">
      <canvas ref={canvasRef} />
    </div>
  );
}

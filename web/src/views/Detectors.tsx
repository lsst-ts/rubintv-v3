import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { useLiveTopic } from "../lib/LiveContext";
import { usePageTitle } from "../lib/usePageTitle";
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
  // Site-wide subscription (empty location keys the detectors||| topic).
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
    <section className="cluster-status">
      <h1>Cluster Status</h1>
      {!hasAny && (
        <p className="skeleton">
          Awaiting cluster status. (Requires Redis streams configured for this
          deployment.)
        </p>
      )}
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
          <h3>Backlog Workers</h3>
          <Cells payload={sets.spareWorkers} fallbackCount={4} prefix="spareworkers" />
          <RestartButton name="spareWorkers" title="Backlog Workers" onRestart={restart} admin={admin} />
        </div>
        <OtherQueues payload={sets.otherQueues} />
      </div>
    </section>
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
      <h2 className="detector-title">{title}</h2>
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
      <h2 className="detector-title">{title}</h2>
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
      confirmLabel="Restart — confirm?"
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
        <h3>Other Queues</h3>
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

// Typed fetch client. All calls go to same-origin {BASE}/api (Vite proxies to
// FastAPI in dev). Types come from the OpenAPI-generated schema.

import { BASE } from "./basePath";
import type {
  AdminActionOut,
  AdminMenusOut,
  AdminStatusOut,
  CalendarOut,
  CameraOut,
  ControlsOut,
  DatePayload,
  DetectorsConfigOut,
  LocationOut,
  LocationSummary,
  Metadata,
  NightReportOut,
  StatusResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}/api${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new ApiError(resp.status, `GET ${path} -> ${resp.status}`);
  }
  return (await resp.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    // Surface the server detail so admin actions can show why they failed
    // (e.g. 503 "redis is not configured", 403 admin gate).
    let detail = `${resp.status}`;
    try {
      const data = (await resp.json()) as { detail?: string };
      if (data.detail) detail = data.detail;
    } catch {
      // non-JSON body; keep the status code
    }
    throw new ApiError(resp.status, `POST ${path} -> ${detail}`);
  }
  return (await resp.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  locations: () => getJson<LocationSummary[]>("/locations"),

  // Deployment bootstrap: the site the backend pod runs under (RUBINTV_SITE —
  // "summit", "usdf-k8s", "local"…). Distinct from the viewed location; drives
  // the header's processing banner and non-prod flag.
  config: () => getJson<{ site: string }>("/config"),

  status: () => getJson<StatusResponse>("/health/status"),

  location: (loc: string) => getJson<LocationOut>(`/locations/${enc(loc)}`),

  camera: (loc: string, cam: string) =>
    getJson<CameraOut>(`/locations/${enc(loc)}/cameras/${enc(cam)}`),

  calendar: (loc: string, cam: string) =>
    getJson<CalendarOut>(`/locations/${enc(loc)}/cameras/${enc(cam)}/calendar`),

  datePayload: (loc: string, cam: string, date: string) =>
    getJson<DatePayload>(
      `/locations/${enc(loc)}/cameras/${enc(cam)}/dates/${enc(date)}`,
    ),

  // Backstop for the WS metadata stream: the full metadata.json for a date.
  // The grid renders without this (from datePayload); cells fill from the
  // stream, with this REST query covering clients whose stream drops.
  metadata: (loc: string, cam: string, date: string) =>
    getJson<Metadata>(
      `/locations/${enc(loc)}/cameras/${enc(cam)}/metadata/${enc(date)}`,
    ),

  nightReport: (loc: string, cam: string, date: string) =>
    getJson<NightReportOut>(
      `/locations/${enc(loc)}/cameras/${enc(cam)}/night-report/${enc(date)}`,
    ),

  controls: (loc: string) =>
    getJson<ControlsOut>(`/locations/${enc(loc)}/admin/controls`),

  // Site-wide control readback + admin menus + detector streams. These are
  // deployment-wide (their config is not nested under a location).
  siteControls: () => getJson<ControlsOut>("/admin/controls"),

  adminMenus: () => getJson<AdminMenusOut>("/admin/menus"),

  detectorsConfig: () => getJson<DetectorsConfigOut>("/detectors/config"),

  // Admin panel: header info + write actions. The control writes go to Redis
  // (plain SET); the readback returns asynchronously over the admin WS topic.
  adminStatus: () => getJson<AdminStatusOut>("/admin/status"),

  setControl: (key: string, value: string) =>
    postJson<AdminActionOut>("/admin/controls/set", { key, value }),

  setWitnessDetector: (value: string) =>
    postJson<AdminActionOut>("/admin/witness-detector", { key: "", value }),

  resetHeadNode: () => postJson<AdminActionOut>("/admin/reset-head-node"),

  flushHistorical: () => postJson<AdminActionOut>("/admin/flush-historical"),

  flushRedis: () => postJson<AdminActionOut>("/admin/flush-redis"),

  restartWorkers: (setName: string) =>
    postJson<AdminActionOut>(`/detectors/${enc(setName)}/restart`),

  // Build a proxied media URL for a channel artifact.
  mediaUrl: (
    loc: string,
    cam: string,
    channel: string,
    date: string,
    seq: string,
    filename: string,
  ) =>
    `${BASE}/api/locations/${enc(loc)}/cameras/${enc(cam)}/channels/${enc(channel)}/` +
    `${enc(date)}/${enc(seq)}/${enc(filename)}`,

  // Build a proxied URL for a night-report plot. The plot key is fully known
  // ({camera}/{date}/night_report/{group}/{filename}), so the dedicated route
  // GETs it directly rather than resolving by prefix listing.
  nightReportPlotUrl: (
    loc: string,
    cam: string,
    date: string,
    group: string,
    filename: string,
  ) =>
    `${BASE}/api/locations/${enc(loc)}/cameras/${enc(cam)}/night-report/` +
    `${enc(date)}/plot/${enc(group)}/${enc(filename)}`,

  // Build a proxied media URL from a raw per-day S3 key. Per-day keys follow
  // `{camera}/{date}/{channel}/{seq}/{filename}.{ext}` (the seq segment is a
  // word sentinel like "final"). The proxy route resolves the actual object by
  // listing that prefix, so we only need channel/date/seq/filename — there is
  // no `/api/{rawkey}` route to serve the key directly.
  perDayMediaUrl: (loc: string, cam: string, key: string): string | null => {
    const parts = key.split("/");
    if (parts.length < 5) return null;
    const [, date, channel, seq, ...rest] = parts;
    return api.mediaUrl(loc, cam, channel, date, seq, rest.join("/"));
  },
};

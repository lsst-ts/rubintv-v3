// Typed fetch client. All calls go to same-origin /api (Vite proxies to
// FastAPI in dev). Types come from the OpenAPI-generated schema.

import type {
  CalendarOut,
  CameraOut,
  ControlsOut,
  DatePayload,
  LocationOut,
  LocationSummary,
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
  const resp = await fetch(`/api${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new ApiError(resp.status, `GET ${path} -> ${resp.status}`);
  }
  return (await resp.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  locations: () => getJson<LocationSummary[]>("/locations"),

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

  nightReport: (loc: string, cam: string, date: string) =>
    getJson<NightReportOut>(
      `/locations/${enc(loc)}/cameras/${enc(cam)}/night-report/${enc(date)}`,
    ),

  controls: (loc: string) =>
    getJson<ControlsOut>(`/locations/${enc(loc)}/admin/controls`),

  // Build a proxied media URL for a channel artifact.
  mediaUrl: (
    loc: string,
    cam: string,
    channel: string,
    date: string,
    seq: string,
    filename: string,
  ) =>
    `/api/locations/${enc(loc)}/cameras/${enc(cam)}/channels/${enc(channel)}/` +
    `${enc(date)}/${enc(seq)}/${enc(filename)}`,

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

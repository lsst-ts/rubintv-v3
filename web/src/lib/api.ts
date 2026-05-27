// Typed fetch client. All calls go to the same-origin /api (Vite proxies to
// FastAPI in dev; same origin in prod). Endpoints are stubs in Phase 1 and
// fleshed out in Phase 3.

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

export interface HealthLive {
  status: string;
  version: string;
}

export const api = {
  health: () => getJson<HealthLive>("/health/live"),
};

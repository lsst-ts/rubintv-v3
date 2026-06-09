import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { StatusResponse } from "../lib/types";

// Non-blocking banner shown while the backend is still scanning historical
// data. Collection is per-camera (recent window first, then the full
// back-catalogue), so when a camera is in view the banner scopes itself to
// THAT camera: it clears once the camera's full sweep is done, and softens
// its wording once the recent window is ready. Off a camera (landing/location
// pages) it falls back to the site-wide loading flag.
//
// The wording also reflects the cache situation: a warm start (snapshot
// loaded at boot) means older dates already show and the scan is a refresh,
// whereas a cold start means older dates appear only as the sweep finds them.

interface Props {
  location?: string;
  camera?: string;
}

// What to show given the status payload and the camera in view (if any).
// Returns null when nothing should be shown — used both for rendering and to
// decide whether to keep polling.
function bannerMessage(
  data: StatusResponse | undefined,
  location?: string,
  camera?: string,
): string | null {
  if (!data) return null;
  // A warm start has the calendar populated from cache, so an in-progress
  // scan is just a refresh — don't imply older dates are missing.
  const scanning = data.warm_start
    ? "Refreshing historical data… showing cached dates."
    : "Loading historical data… older dates may be incomplete.";
  if (location && camera) {
    const status = (data.cameras ?? []).find(
      (c) => c.location === location && c.camera === camera,
    );
    // Unknown camera: nothing scoped to show.
    if (!status || status.full_complete) return null;
    if (data.warm_start) return scanning;
    return status.recent_ready
      ? "Recent dates are ready; older dates are still loading…"
      : scanning;
  }
  // No camera in view: site-wide affordance.
  return data.historical_loading ? scanning : null;
}

export function LoadingBanner({ location, camera }: Props) {
  const { data } = useQuery({
    queryKey: ["status"],
    queryFn: () => api.status(),
    // Poll while there's still something to report for the current scope.
    refetchInterval: (query) =>
      bannerMessage(query.state.data, location, camera) === null ? false : 5000,
  });

  const message = bannerMessage(data, location, camera);
  if (message === null) return null;

  return (
    <div className="loading-banner" role="status">
      {message}
    </div>
  );
}

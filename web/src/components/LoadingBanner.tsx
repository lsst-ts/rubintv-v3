import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { StatusResponse } from "../lib/types";

// Non-blocking banner shown while the backend is still scanning historical
// data. Collection is per-camera (recent window first, then the full
// back-catalogue), so when a camera is in view the banner scopes itself to
// THAT camera: it clears once the camera's full sweep is done, and softens
// its wording once the recent window is ready. Off a camera (landing/location
// pages) it falls back to the site-wide loading flag.

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
  if (location && camera) {
    const status = (data.cameras ?? []).find(
      (c) => c.location === location && c.camera === camera,
    );
    // Unknown camera: nothing scoped to show.
    if (!status || status.full_complete) return null;
    return status.recent_ready
      ? "Recent dates are ready; older dates are still loading…"
      : "Loading historical data… older dates may be incomplete.";
  }
  // No camera in view: site-wide affordance.
  return data.historical_loading
    ? "Loading historical data… older dates may be incomplete."
    : null;
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

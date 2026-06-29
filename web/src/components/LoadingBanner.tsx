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
// The inline pill shows a short label; the fuller sentence rides along as a
// tooltip. Returns null when nothing should be shown — used both for rendering
// and to decide whether to keep polling.
interface BannerState {
  label: string;
  title: string;
  // True when the scan can't actually progress because the server can't reach
  // S3. The pill stops spinning and rewords so it doesn't imply progress.
  stalled?: boolean;
}

function bannerState(
  data: StatusResponse | undefined,
  location?: string,
  camera?: string,
): BannerState | null {
  if (!data) return null;
  // If the server can't reach S3, the scan is stalled regardless of scope:
  // a spinning "Refreshing" pill would falsely imply progress. Reword and
  // freeze the spinner so the loading affordance matches the S3 alert beside
  // it. (Still only shown while there's a scan to report — see below.)
  const stalled: BannerState = {
    label: "Refresh stalled",
    title:
      "Can't reach S3 — historical data isn't updating. Cached dates are still shown.",
    stalled: true,
  };
  // A warm start has the calendar populated from cache, so an in-progress
  // scan is just a refresh — don't imply older dates are missing.
  const scanning: BannerState = data.s3_healthy === false
    ? stalled
    : data.warm_start
    ? {
        label: "Refreshing",
        title: "Refreshing historical data… cached dates are shown meanwhile.",
      }
    : {
        label: "Loading dates",
        title: "Loading historical data… older dates may be incomplete.",
      };
  if (location && camera) {
    const status = (data.cameras ?? []).find(
      (c) => c.location === location && c.camera === camera,
    );
    // Unknown camera: nothing scoped to show.
    if (!status || status.full_complete) return null;
    // Stalled or warm-start wording overrides the recent/older distinction:
    // neither stage is making progress (stalled) or both are cache-backed.
    if (scanning.stalled || data.warm_start) return scanning;
    return status.recent_ready
      ? {
          label: "Loading older",
          title: "Recent dates are ready; older dates are still loading…",
        }
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
      bannerState(query.state.data, location, camera) === null ? false : 5000,
  });

  const state = bannerState(data, location, camera);
  if (state === null) return null;

  return (
    <span
      className={`conn scan-pill${state.stalled ? " scan-stalled" : ""}`}
      role="status"
      title={state.title}
    >
      <span className="scan-spinner" aria-hidden="true" />
      {state.label}
    </span>
  );
}

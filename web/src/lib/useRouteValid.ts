import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api, ApiError } from "./api";
import { queryKeys } from "./liveQuery";
import { STALE } from "./queryClient";

// Whether the :location/:camera/:channel in the URL name things that actually
// exist in this deployment's config. Bad names used to render a half-built
// shell (breadcrumbs and tabs for a camera that isn't there, "Could not load"
// in the body); now the route resolves to a 404 page instead.
//
// The answer is three-valued because it can't be known synchronously: the
// config arrives over the same /api/locations + /api/cameras queries the views
// already issue, so React Query dedupes them and this costs no extra request.
//   "pending" — config still loading; render the view's own skeleton.
//   "valid"   — every param in the URL names a real thing.
//   "missing" — a param names something the config doesn't have -> 404.
export type RouteValidity = "pending" | "valid" | "missing";

// A camera fetch that 404s means the camera doesn't exist; any other failure
// (network, 500) is a transient error, not a missing route — those keep the
// view's existing "Could not load" path rather than claiming the URL is wrong.
function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function useRouteValid(): RouteValidity {
  const { location = "", camera = "", channel = "" } = useParams();

  const locationsQ = useQuery({
    queryKey: queryKeys.locations(),
    queryFn: api.locations,
    staleTime: STALE.config,
    enabled: !!location,
  });

  const cameraQ = useQuery({
    queryKey: queryKeys.camera(location, camera),
    queryFn: () => api.camera(location, camera),
    staleTime: STALE.config,
    enabled: !!location && !!camera,
  });

  // Nothing to check on a route with no params (Home, and the system pages,
  // whose paths are fixed by the route table).
  if (!location) return "valid";

  if (locationsQ.isPending) return "pending";
  // A failed locations fetch is a transient error, not proof the location is
  // absent — don't 404 the user out of a real page because the network blipped.
  if (locationsQ.isError) return "valid";
  const known = Array.isArray(locationsQ.data) ? locationsQ.data : [];
  if (!known.some((l) => l.name === location)) return "missing";

  if (!camera) return "valid";
  if (cameraQ.isPending) return "pending";
  if (isNotFound(cameraQ.error)) return "missing";
  if (cameraQ.isError || !cameraQ.data) return "valid";

  // The channel segment, where the route has one. Per-day channels are
  // addressable too, so both kinds count.
  if (!channel) return "valid";
  const channels = Array.isArray(cameraQ.data.channels)
    ? cameraQ.data.channels
    : [];
  return channels.some((c) => c.name === channel) ? "valid" : "missing";
}

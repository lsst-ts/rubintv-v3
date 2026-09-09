import type { ReactNode } from "react";
import { useRouteValid } from "../lib/useRouteValid";
import { NotFound } from "../views/NotFound";

// Wraps a parameterised route so a URL naming a location/camera/channel that
// doesn't exist renders the 404 page instead of the view.
//
// While the config that answers that question is in flight we render a
// skeleton rather than the view. Mounting the view first would let it fetch
// and render against data for a thing that isn't there — and the views assume
// their camera exists (indexing straight into a payload the backend 404'd),
// so the crash beat the guard to the screen. Holding back one config fetch is
// cheap: it's the same /api/locations + camera query the view itself needs, so
// nothing is fetched twice and the view mounts the moment the config lands.
export function RouteGuard({ children }: { children: ReactNode }) {
  const validity = useRouteValid();
  if (validity === "missing") return <NotFound />;
  if (validity === "pending") return <p className="skeleton">Loading…</p>;
  return <>{children}</>;
}

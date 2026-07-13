import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";
import { usePageTitle } from "../lib/usePageTitle";
import { useSubapps } from "../lib/useSubapps";
import { NavMenu } from "../components/NavMenu";
import { RubinMark } from "../components/RubinMark";
import type { LocationSummary } from "../lib/types";

// Home page: the full-bleed launcher and the ONLY place that carries the brand
// (the mark + wordmark hero). The app-shell sidebar is gone, so the card grids
// are the navigation — three grouped sections of text cards:
//   1. Processing Locations  (real observing sites, is_teststand === false)
//   2. Test-stand Locations  (is_teststand === true)
//   3. Apps                  (Cluster status, if any location has it, +
//                             mounted sub-apps)
// Each section is hidden when it has no entries. Ported from the RubinTV Design
// System launcher home (ui_kits/rubintv); cards carry only real data (title,
// id, freshness) — no fabricated blurbs, counts, or camera photos.

// A mounted sub-app path ("/rubintv/ddv") turned into a card. The last path
// segment is the app id; short ids ("ddv") are upper-cased.
function subappLabel(path: string): string {
  const id = path.replace(/\/$/, "").split("/").pop() ?? path;
  return id.length <= 3 ? id.toUpperCase() : id[0].toUpperCase() + id.slice(1);
}

function LocationCard({ loc }: { loc: LocationSummary }) {
  return (
    <Link className="loc-card" to={`/${loc.name}`}>
      <div className="loc-card-top">
        <span className="loc-name">{loc.title}</span>
        <span className="loc-arrow" aria-hidden="true">
          →
        </span>
      </div>
      <div className="loc-label">{loc.name}</div>
    </Link>
  );
}

export function Home() {
  usePageTitle();
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.locations(),
    queryFn: api.locations,
    staleTime: STALE.config,
  });
  const subapps = useSubapps();

  const locations = data ?? [];

  // Single-location deployments (summit, base, tucson…) have no meaningful
  // landing to make — a page with one lone card — so go straight to that
  // location. `replace` keeps it out of history, so Back doesn't bounce here.
  if (locations.length === 1) {
    return <Navigate to={`/${locations[0].name}`} replace />;
  }

  const processing = locations.filter((l) => !l.is_teststand);
  const teststands = locations.filter((l) => l.is_teststand);
  const hasClusterStatus = locations.some((l) => l.has_cluster_status);

  return (
    <div className="landing" data-screen-label="home">
      {/* The NavMenu drawer floats top-right; the brand hero carries the mark. */}
      <div className="home-toggle">
        <NavMenu />
      </div>
      <div className="landing-inner">
        <div className="home-hero">
          <RubinMark className="brand-logo" />
        </div>
        <div className="home-tagline">
          <b>RubinTV</b>
          <span className="sep" />
          live camera displays
        </div>

        {isPending && <p className="skeleton">Loading locations…</p>}
        {isError && <p role="alert">Could not load locations.</p>}

        {processing.length > 0 && (
          <>
            <div className="landing-h">Choose a location</div>
            <div className="loc-grid">
              {processing.map((loc) => (
                <LocationCard key={loc.name} loc={loc} />
              ))}
            </div>
          </>
        )}

        {teststands.length > 0 && (
          <>
            <div className="landing-h">Test-stand locations</div>
            <div className="loc-grid">
              {teststands.map((loc) => (
                <LocationCard key={loc.name} loc={loc} />
              ))}
            </div>
          </>
        )}

        {/* Apps: Cluster status (when a location advertises it) and any mounted
            sub-apps, then the deployment-wide Scan status + Admin pages — which
            are always available, so this section always renders. Mirrors the
            NavMenu drawer's Apps list. */}
        <div className="landing-h">Apps</div>
        <div className="loc-grid">
          {hasClusterStatus && (
            <Link className="loc-card" to="/detectors">
              <div className="loc-card-top">
                <span className="loc-name">Cluster status</span>
                <span className="loc-arrow" aria-hidden="true">
                  →
                </span>
              </div>
              <div className="loc-label">redis · worker health</div>
            </Link>
          )}
          {/* Sub-apps live outside the SPA router, so plain anchors. */}
          {subapps.map((path) => (
            <a key={path} className="loc-card" href={path}>
              <div className="loc-card-top">
                <span className="loc-name">{subappLabel(path)}</span>
                <span className="loc-arrow" aria-hidden="true">
                  →
                </span>
              </div>
              <div className="loc-label">{path}</div>
            </a>
          ))}
          <Link className="loc-card" to="/status">
            <div className="loc-card-top">
              <span className="loc-name">Scan status</span>
              <span className="loc-arrow" aria-hidden="true">
                →
              </span>
            </div>
            <div className="loc-label">calendar scan progress</div>
          </Link>
          <Link className="loc-card" to="/admin">
            <div className="loc-card-top">
              <span className="loc-name">Admin</span>
              <span className="loc-arrow" aria-hidden="true">
                →
              </span>
            </div>
            <div className="loc-label">redis controls</div>
          </Link>
        </div>
      </div>
    </div>
  );
}

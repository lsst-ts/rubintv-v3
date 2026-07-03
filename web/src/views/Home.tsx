import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "react-router-dom";
import { api } from "../lib/api";
import { logoButtonStyle } from "../lib/logoButton";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";
import { usePageTitle } from "../lib/usePageTitle";
import { useSubapps } from "../lib/useSubapps";
import type { LocationSummary } from "../lib/types";

// Home page: three grouped sections of full-bleed logo buttons —
//   1. Processing Locations  (real observing sites, is_teststand === false)
//   2. Apps                  (mounted sub-apps + Cluster status, if present)
//   3. Test-stand Locations  (is_teststand === true)
// Each section is hidden when it has no buttons (e.g. a single-site deploy has
// no test-stands, or Apps is empty when no sub-app is mounted).

// A mounted sub-app path (e.g. "/rubintv/ddv") turned into a Home button.
// The last path segment is the app id; we title-case it for the label and look
// up a matching logo (DDV has ddv.jpg; others fall back to a plain button).
const SUBAPP_LOGOS: Record<string, string> = { ddv: "ddv.jpg" };

interface AppButton {
  key: string;
  href: string;
  title: string;
  style: ReturnType<typeof logoButtonStyle>;
}

function subappButton(path: string): AppButton {
  const id = path.replace(/\/$/, "").split("/").pop() ?? path;
  const title = id.length <= 3 ? id.toUpperCase() : id[0].toUpperCase() + id.slice(1);
  return {
    key: path,
    href: path,
    title,
    style: logoButtonStyle({ logo: SUBAPP_LOGOS[id], text_colour: "#fff", text_shadow: true }),
  };
}

function LocationButton({ loc }: { loc: LocationSummary }) {
  return (
    <li>
      <Link className="logo-button" to={`/${loc.name}`} style={logoButtonStyle(loc)}>
        <span className="logo-button-title">{loc.title}</span>
      </Link>
    </li>
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
  // landing to make — a page with one lone button — so go straight to that
  // location. `replace` keeps it out of history, so Back doesn't bounce here.
  if (locations.length === 1) {
    return <Navigate to={`/${locations[0].name}`} replace />;
  }

  const processing = locations.filter((l) => !l.is_teststand);
  const teststands = locations.filter((l) => l.is_teststand);

  // Apps: the mounted sub-apps, plus a single Cluster status button when any
  // visible location advertises one. Sub-apps live outside the SPA router, so
  // they're plain anchors; Cluster status is an in-app route.
  const apps: AppButton[] = subapps.map(subappButton);
  if (locations.some((l) => l.has_cluster_status)) {
    apps.push({
      key: "cluster-status",
      href: "/detectors",
      title: "Cluster status",
      // The logo already has the title baked in, so hide the overlaid text
      // (kept in the DOM, transparent, for screen readers / image-load failure).
      style: logoButtonStyle({
        logo: "cluster-status.jpg",
        text_colour: "rgba(0,0,0,0)",
      }),
    });
  }

  return (
    <section>
      <h1>RubinTV</h1>
      {isPending && <p className="skeleton">Loading locations…</p>}
      {isError && <p role="alert">Could not load locations.</p>}

      {processing.length > 0 && (
        <div className="camera-group">
          <h2>Processing Locations</h2>
          <ul className="button-grid">
            {processing.map((loc) => (
              <LocationButton key={loc.name} loc={loc} />
            ))}
          </ul>
        </div>
      )}

      {apps.length > 0 && (
        <div className="camera-group">
          <h2>Apps</h2>
          <ul className="button-grid">
            {apps.map((app) =>
              app.href.startsWith("/detectors") ? (
                <li key={app.key}>
                  <Link className="logo-button" to={app.href} style={app.style}>
                    <span className="logo-button-title">{app.title}</span>
                  </Link>
                </li>
              ) : (
                <li key={app.key}>
                  <a className="logo-button" href={app.href} style={app.style}>
                    <span className="logo-button-title">{app.title}</span>
                  </a>
                </li>
              ),
            )}
          </ul>
        </div>
      )}

      {teststands.length > 0 && (
        <div className="camera-group">
          <h2>Test-stand Locations</h2>
          <ul className="button-grid">
            {teststands.map((loc) => (
              <LocationButton key={loc.name} loc={loc} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

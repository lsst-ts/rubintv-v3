import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { logoButtonStyle } from "../lib/logoButton";
import { queryKeys } from "../lib/liveQuery";
import { STALE, cameraDataState } from "../lib/queryClient";
import { usePageTitle } from "../lib/usePageTitle";

const DOT_TITLE: Record<string, string> = {
  offline: "Offline — this camera is disabled in the configuration.",
  fresh: "Live — this camera has data for the current observing day.",
  stale: "Stale — no data yet for the current observing day; showing an earlier night.",
};

// Camera groups with cards and a fresh/stale/offline data indicator.
export function Location() {
  const { location = "" } = useParams();
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.location(location),
    queryFn: () => api.location(location),
    staleTime: STALE.config,
  });
  usePageTitle(data?.title ?? location);

  if (isPending) return <p className="skeleton">Loading…</p>;
  if (isError || !data) return <p role="alert">Could not load location.</p>;

  return (
    <section>
      <h1>{data.title}</h1>
      {data.has_cluster_status && (
        <div className="camera-group">
          <h2>Apps</h2>
          <ul className="button-grid">
            <li>
              <Link
                className="logo-button"
                to="/detectors"
                // The logo already has the title baked in, so hide the overlaid
                // text (kept for screen readers / if the image fails to load).
                style={logoButtonStyle({
                  logo: "cluster-status.jpg",
                  text_colour: "rgba(0,0,0,0)",
                })}
              >
                <span className="logo-button-title">Cluster status</span>
              </Link>
            </li>
          </ul>
        </div>
      )}
      {data.camera_groups.map((group) => (
        <div key={group.label} className="camera-group">
          <h2>{group.label}</h2>
          <ul className="button-grid">
            {group.cameras.map((cam) => {
              const state = cameraDataState(cam.online, cam.latest_date);
              return (
                <li key={cam.name}>
                  <Link
                    className={`logo-button ${state === "offline" ? "offline" : ""}`}
                    to={`/${location}/${cam.name}`}
                    style={logoButtonStyle(cam)}
                  >
                    <span
                      className={`logo-button-dot dot ${state}`}
                      title={DOT_TITLE[state]}
                      aria-label={DOT_TITLE[state]}
                    />
                    <span className="logo-button-title">{cam.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

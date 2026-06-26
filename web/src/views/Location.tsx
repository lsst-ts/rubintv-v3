import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
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
        <nav className="location-nav" aria-label="Location views">
          <Link to="/detectors">Cluster status</Link>
        </nav>
      )}
      {data.camera_groups.map((group) => (
        <div key={group.label} className="camera-group">
          <h2>{group.label}</h2>
          <ul className="card-grid">
            {group.cameras.map((cam) => {
              const state = cameraDataState(cam.online, cam.latest_date);
              return (
                <li
                  key={cam.name}
                  className={`card ${state === "offline" ? "offline" : ""}`}
                >
                  <Link to={`/${location}/${cam.name}`}>{cam.title}</Link>
                  <span
                    className={`dot ${state}`}
                    title={DOT_TITLE[state]}
                    aria-label={DOT_TITLE[state]}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

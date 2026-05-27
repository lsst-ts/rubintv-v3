import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";

// Camera groups with cards and online/offline indicators.
export function Location() {
  const { location = "" } = useParams();
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.location(location),
    queryFn: () => api.location(location),
    staleTime: STALE.config,
  });

  if (isPending) return <p className="skeleton">Loading…</p>;
  if (isError || !data) return <p role="alert">Could not load location.</p>;

  return (
    <section>
      <h1>{data.title}</h1>
      {data.camera_groups.map((group) => (
        <div key={group.label} className="camera-group">
          <h2>{group.label}</h2>
          <ul className="card-grid">
            {group.cameras.map((cam) => (
              <li key={cam.name} className={`card ${cam.online ? "" : "offline"}`}>
                <Link to={`/${location}/${cam.name}`}>{cam.title}</Link>
                <span className={`dot ${cam.online ? "online" : "offline"}`} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

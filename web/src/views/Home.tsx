import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";

// Location grid. Config data is static (staleTime Infinity).
export function Home() {
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.locations(),
    queryFn: api.locations,
    staleTime: STALE.config,
  });

  return (
    <section>
      <h1>RubinTV</h1>
      {isPending && <p className="skeleton">Loading locations…</p>}
      {isError && <p role="alert">Could not load locations.</p>}
      <ul className="card-grid">
        {data?.map((loc) => (
          <li key={loc.name} className="card">
            <Link to={`/${loc.name}`}>{loc.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

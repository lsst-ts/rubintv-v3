import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { STALE } from "../lib/queryClient";

// Phase 1 Home: proves the API client + TanStack Query wiring end to end by
// reading the backend health endpoint. Phase 5 replaces this with the
// location grid.
export function Home() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    staleTime: STALE.config,
  });

  return (
    <section>
      <h1>RubinTV</h1>
      {isPending && <p className="skeleton">Loading…</p>}
      {isError && <p role="alert">Backend unreachable.</p>}
      {data && (
        <p>
          Backend <strong>{data.status}</strong> (v{data.version})
        </p>
      )}
    </section>
  );
}

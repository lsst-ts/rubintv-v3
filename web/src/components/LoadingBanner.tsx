import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

// Non-blocking banner shown while the backend is still scanning the
// historical back-catalogue. Polls /api/health/status and stops once history
// has loaded; older dates may be incomplete until then, so we warn rather
// than block (the views still render whatever is already indexed).
export function LoadingBanner() {
  const { data } = useQuery({
    queryKey: ["status"],
    queryFn: () => api.status(),
    // Poll while loading; refetchInterval returns false to stop once done.
    refetchInterval: (query) =>
      query.state.data?.historical_loading === false ? false : 5000,
  });

  if (!data?.historical_loading) return null;

  return (
    <div className="loading-banner" role="status">
      Loading historical data… older dates may be incomplete.
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useLiveTopic } from "../lib/LiveContext";

// Admin control readback. Values update live via the admin topic; setting a
// value is a POST (gated server-side on the per-location admin user list).
// The control menus themselves come from deployment config; this renders
// the current readback values.
export function Admin() {
  const { location = "", camera = "" } = useParams();
  useLiveTopic({ topic: "admin", location, camera });

  const { data, isPending } = useQuery({
    queryKey: ["controls", location],
    queryFn: () => api.controls(location),
    staleTime: 0,
  });

  return (
    <section>
      <h1>Admin — {location}</h1>
      {isPending && <p className="skeleton">Loading controls…</p>}
      <table className="data-table">
        <thead>
          <tr>
            <th>Control</th>
            <th>Readback value</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data?.values ?? {}).map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

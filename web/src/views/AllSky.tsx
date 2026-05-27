import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";

// All-sky: current still + movie playback for a date. Per-day artifacts come
// from the date payload's per_day map.
export function AllSky() {
  const { location = "", camera = "" } = useParams();
  const [params, setParams] = useSearchParams();

  useLiveTopic({ topic: "camera", location, camera });

  const { data: calendar } = useQuery({
    queryKey: queryKeys.calendar(location, camera),
    queryFn: () => api.calendar(location, camera),
    staleTime: STALE.calendar,
  });
  const date = params.get("date") ?? calendar?.dates[0] ?? "";

  const { data: payload } = useQuery({
    queryKey: queryKeys.datePayload(location, camera, date),
    queryFn: () => api.datePayload(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  const proxied = (key: string) => `/api/${key}`;

  return (
    <section>
      <h1>All Sky</h1>
      <label>
        Date{" "}
        <select value={date} onChange={(e) => setParams({ date: e.target.value })}>
          {calendar?.dates.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <div className="allsky-media">
        {Object.entries(payload?.per_day ?? {}).map(([chan, key]) =>
          key.endsWith(".mp4") ? (
            <video key={chan} src={proxied(key)} controls />
          ) : (
            <img key={chan} src={proxied(key)} alt={chan} />
          ),
        )}
      </div>
    </section>
  );
}

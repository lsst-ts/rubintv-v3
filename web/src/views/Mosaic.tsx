import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { usePageTitle } from "../lib/usePageTitle";

// Grid of per-day media with metadata. Reuses the date payload's per_day map.
export function Mosaic() {
  const { location = "", camera = "" } = useParams();
  const [params, setParams] = useSearchParams();
  usePageTitle("Mosaic / Movies", camera);

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

  return (
    <section>
      <h1>Mosaic / Movies</h1>
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
      <div className="card-grid">
        {Object.entries(payload?.per_day ?? {}).map(([chan, key]) => {
          const src = api.perDayMediaUrl(location, camera, key);
          if (src === null) return null;
          return (
            <figure key={chan} className="card">
              {key.endsWith(".mp4") ? (
                <video src={src} controls />
              ) : (
                <img src={src} alt={chan} loading="lazy" />
              )}
              <figcaption>{chan}</figcaption>
            </figure>
          );
        })}
      </div>
    </section>
  );
}

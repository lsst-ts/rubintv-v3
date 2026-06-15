import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { usePageTitle } from "../lib/usePageTitle";

// Nightly summary: text sections + grouped plot gallery. The UI label is
// deliberately neutral ("Nightly Summary"); the route/API keep night-report.
// Live during the night via the nightReport topic.
export function NightReport() {
  const { location = "", camera = "" } = useParams();
  const [params] = useSearchParams();
  const date = params.get("date") ?? "";

  usePageTitle("Nightly Summary", camera, date);

  useLiveTopic({ topic: "nightReport", location, camera });

  const { data, isPending } = useQuery({
    queryKey: queryKeys.nightReport(location, camera, date),
    queryFn: () => api.nightReport(location, camera, date),
    enabled: date !== "",
    staleTime: STALE.nightReport,
  });

  if (isPending && date) return <p className="skeleton">Loading…</p>;
  if (!data?.exists) return <p>No summary for this date.</p>;

  const groups = new Map<string, typeof data.plots>();
  for (const plot of data.plots) {
    const list = groups.get(plot.group) ?? [];
    list.push(plot);
    groups.set(plot.group, list);
  }

  return (
    <section>
      <h1>Nightly Summary — {date}</h1>
      {data.text.map((item, i) => (
        <article key={i} className="nr-text">
          <h3>{String((item as Record<string, unknown>).title ?? "")}</h3>
          <p>{String((item as Record<string, unknown>).content ?? "")}</p>
        </article>
      ))}
      {[...groups.entries()].map(([group, plots]) => (
        <div key={group} className="nr-group">
          <h2>{group}</h2>
          <div className="plot-gallery">
            {plots.map((p) => (
              <figure key={p.key}>
                <img
                  src={api.nightReportPlotUrl(
                    location,
                    camera,
                    date,
                    p.group,
                    p.filename,
                  )}
                  alt={p.filename}
                  loading="lazy"
                />
                <figcaption>{p.filename}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

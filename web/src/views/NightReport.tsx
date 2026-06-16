import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import type { NightReportText } from "../lib/types";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { usePageTitle } from "../lib/usePageTitle";

// One text section. The item is a discriminated union on `type`; each kind
// renders its content differently (paragraph / key-values / link list).
function TextItem({ item }: { item: NightReportText }) {
  return (
    <article className="nr-text">
      <h3>{item.title}</h3>
      {item.type === "multiline" && <p className="nr-multiline">{item.content}</p>}
      {item.type === "keyvalues" && (
        <dl className="nr-keyvalues">
          {Object.entries(item.content).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {item.type === "links" && (
        <ul className="nr-links">
          {item.content.map((link) => (
            <li key={link.url}>
              <a href={link.url} target="_blank" rel="noreferrer">
                {link.text}
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

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
        <TextItem key={i} item={item} />
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

import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import type { NightReportOut, NightReportText } from "../lib/types";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { usePageTitle } from "../lib/usePageTitle";

// The API doesn't re-export PlotOut by name; derive it from the report shape.
type Plot = NightReportOut["plots"][number];

// Slugify a title into a stable tab id (mirrors the real sanitiseString).
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Only http(s) or site-relative link targets may reach an <a href>. Night
// report text is operator-authored (read from the bucket), so a `javascript:`
// URL would run script in this origin on click. The server already rejects
// these, but guard on the client too so a bad value renders inert rather than
// dangerous. Returns a safe href, or undefined to render the link disabled.
function safeHref(url: string): string | undefined {
  const u = url.trim();
  if (/^https?:\/\//i.test(u) || u.startsWith("/")) return url;
  return undefined;
}

// One text section's body. Discriminated on `type` (paragraph / key-values /
// link list).
function TextPanel({ item }: { item: NightReportText }) {
  if (item.type === "multiline") {
    return <pre className="nr-log">{item.content}</pre>;
  }
  if (item.type === "keyvalues") {
    return (
      <div className="nr-kv">
        {Object.entries(item.content).map(([k, v]) => (
          <Fragment key={k}>
            <div className="k">{k}</div>
            <div className="v">{v}</div>
          </Fragment>
        ))}
      </div>
    );
  }
  return (
    <div className="nr-links">
      {item.content.map((link) => {
        const href = safeHref(link.url);
        return (
          <a
            key={link.url}
            className="nr-link"
            href={href}
            aria-disabled={href === undefined}
            target="_blank"
            rel="noreferrer"
          >
            <span className="lk">{link.text}</span>
            <span className="ld">{link.url}</span>
            <span className="arr">↗</span>
          </a>
        );
      })}
    </div>
  );
}

function PlotPanel({
  plots,
  location,
  camera,
  date,
}: {
  plots: Plot[];
  location: string;
  camera: string;
  date: string;
}) {
  return (
    <div className="nr-plot-grid">
      {plots.map((p) => (
        <figure className="nr-plot" key={p.key}>
          <img
            src={api.nightReportPlotUrl(location, camera, date, p.group, p.filename)}
            alt={p.filename}
            loading="lazy"
          />
          <figcaption>{p.filename}</figcaption>
        </figure>
      ))}
    </div>
  );
}

interface Tab {
  id: string;
  label: string;
  type: "text" | "plot";
  text?: NightReportText;
  plots?: Plot[];
}

// Build the folder-tab model from the report: one tab per text item (in order),
// then one per plot group. Slugs can collide (two titles that slugify the
// same), and a duplicate id makes the second tab unselectable (and a duplicate
// React key), so collisions get a -2, -3… suffix.
function buildTabs(data: NightReportOut): Tab[] {
  const seen = new Map<string, number>();
  const uniqueId = (title: string): string => {
    const base = slug(title);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
  const tabs: Tab[] = data.text.map((item) => ({
    id: uniqueId(item.title),
    label: item.title,
    type: "text",
    text: item,
  }));
  const order: string[] = [];
  const byGroup = new Map<string, Plot[]>();
  for (const p of data.plots) {
    if (!byGroup.has(p.group)) {
      byGroup.set(p.group, []);
      order.push(p.group);
    }
    byGroup.get(p.group)!.push(p);
  }
  for (const g of order) {
    tabs.push({ id: uniqueId(g), label: g, type: "plot", plots: byGroup.get(g) });
  }
  return tabs;
}

// Nightly summary: folder-tabbed text sections + grouped plot panels (ported
// from the design's NightReportView). The UI label is deliberately neutral
// ("Nightly Summary"); the route/API keep night-report. Live during the night
// via the nightReport topic.
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

  const tabs = useMemo(() => (data?.exists ? buildTabs(data) : []), [data]);
  const [selected, setSelected] = useState<string | null>(null);

  // Default to the first tab once the report loads / changes; keep the current
  // selection if it still exists after a live refresh.
  useEffect(() => {
    if (tabs.length === 0) {
      setSelected(null);
    } else if (!tabs.some((t) => t.id === selected)) {
      setSelected(tabs[0].id);
    }
  }, [tabs, selected]);

  if (isPending && date) return <p className="skeleton">Loading…</p>;
  if (!data?.exists) return <p>No summary for this date.</p>;

  const current = tabs.find((t) => t.id === selected) ?? tabs[0];

  return (
    <div className="nr-root">
      <div className="nr-head">
        <h1>Nightly Summary</h1>
        <span className="meta">{date}</span>
      </div>

      <div className="nr-tabwrap">
        <div className="nr-subtabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === current.id}
              className={`nr-subtab ${tab.id === current.id ? "active" : ""}`}
              onClick={() => setSelected(tab.id)}
            >
              <span>{tab.label}</span>
              {tab.type === "plot" ? (
                <span className="pct">{tab.plots?.length}</span>
              ) : (
                <span className="kind">
                  {tab.text?.type === "keyvalues"
                    ? "key/val"
                    : tab.text?.type === "multiline"
                      ? "text"
                      : "links"}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="nr-panel" role="tabpanel">
        {current.type === "plot" ? (
          <PlotPanel
            plots={current.plots ?? []}
            location={location}
            camera={camera}
            date={date}
          />
        ) : (
          <div className="nr-text">
            <div className="lead">
              <span>{current.label}</span>
              <span className="pill">
                {current.text?.type === "keyvalues"
                  ? "KEY / VALUE"
                  : current.text?.type === "multiline"
                    ? "MULTILINE"
                    : "LINKS"}
              </span>
            </div>
            {current.text && <TextPanel item={current.text} />}
          </div>
        )}
      </div>
    </div>
  );
}

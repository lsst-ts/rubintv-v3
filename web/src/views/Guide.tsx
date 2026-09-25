import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { STALE } from "../lib/queryClient";
import { fillTemplate, isDevInstance } from "../lib/links";
import { SEQ_COL, filtersToSeqFilter } from "../lib/filters";
import { usePageTitle } from "../lib/usePageTitle";
import { useGuideConfig } from "../lib/useGuide";
import { renderGuide } from "../guide/timeline";
import type { GuideBlockDatum, GuideLink } from "../guide/timeline";
import type { GuideInstrumentOut } from "../lib/types";
import "../guide/guide.css";

// The observing-block guide: one row per observing day, every science
// program's run of exposures drawn as a block over twilight and moon
// overlays. The chart is the vendored RubinTV Guide timeline (guide/
// timeline.js); this view fetches the blocks the backend groups from ConsDB
// and the program descriptions, and tells the timeline where a block's links
// should go: the observing day and seq range open this deployment's camera
// table, the external links are the camera's configured viewers.

const BLOCK_REFRESH_MS = 60_000;
const SWEEP_REFRESH_MS = 5_000;

function linksFor(inst: GuideInstrumentOut, d: GuideBlockDatum, day: string): GuideLink[] {
  const ctx = { siteLocation: inst.location ?? "", isDevInstance: isDevInstance() };
  const out: GuideLink[] = [];
  if (inst.quicklook_viewer_link) {
    out.push({
      label: "Quick Look viewer",
      href: fillTemplate(inst.quicklook_viewer_link, day, d.seq_num_0, ctx),
    });
  }
  if (inst.image_viewer_link) {
    out.push({
      label: "FITS image viewer",
      href: fillTemplate(inst.image_viewer_link, day, d.seq_num_0, ctx),
    });
  }
  return out;
}

function dayHrefFor(inst: GuideInstrumentOut, day: string): string | null {
  if (!inst.location || !inst.camera) return null;
  return `/${inst.location}/${inst.camera}?date=${day}`;
}

// The camera table for the block's night, filtered to its exposures via the
// table's own ?seq_filter syntax. A block that straddles the day_obs rollover
// (seq numbers restart at 1) is open-ended on each of its nights: the part on
// the first night runs from seq_num_0 up, the part on the last night up to
// seq_num_1, and the same row's link is what the panel shows.
function rangeHrefFor(inst: GuideInstrumentOut, d: GuideBlockDatum, day: string): string | null {
  if (!inst.location || !inst.camera) return null;
  const spans = d.day_obs != null && d.day_obs_end != null && d.day_obs !== d.day_obs_end;
  const dayInt = Number(day.replace(/-/g, ""));
  let filter: { col: string; op: string; value: string };
  if (!spans) {
    filter = { col: SEQ_COL, op: "between", value: `${d.seq_num_0},${d.seq_num_1}` };
  } else if (dayInt === d.day_obs) {
    filter = { col: SEQ_COL, op: ">=", value: String(d.seq_num_0) };
  } else if (dayInt === d.day_obs_end) {
    filter = { col: SEQ_COL, op: "<=", value: String(d.seq_num_1) };
  } else {
    return `/${inst.location}/${inst.camera}?date=${day}`;
  }
  const seqFilter = filtersToSeqFilter([filter]);
  return `/${inst.location}/${inst.camera}?date=${day}&seq_filter=${seqFilter}`;
}

function fmtUpdated(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function Guide() {
  const { instrument: param } = useParams();
  const navigate = useNavigate();
  const config = useGuideConfig();
  const instruments = config?.instruments ?? [];
  // No instrument in the URL means the first configured one.
  const inst = param
    ? instruments.find((i) => i.name === param)
    : instruments[0];
  const name = inst?.name;
  usePageTitle("Guide", inst && inst.name.toUpperCase());

  const blocks = useQuery({
    queryKey: ["guide", "blocks", name],
    queryFn: () => api.guideBlocks(name!),
    enabled: name !== undefined,
    // Poll briskly while the backend's first sweep is filling in, then at
    // the backend's own cadence once it is only tailing new exposures.
    refetchInterval: (q) =>
      q.state.data?.loading ? SWEEP_REFRESH_MS : BLOCK_REFRESH_MS,
  });
  const programs = useQuery({
    queryKey: ["guide", "programs"],
    queryFn: api.guidePrograms,
    staleTime: STALE.calendar,
  });

  const rootRef = useRef<HTMLDivElement>(null);
  // react-query shares unchanged sub-objects between refetches, so `blockList`
  // keeps its identity while the blocks are the same and the chart (with its
  // selection and scroll position) is only rebuilt when a block changes.
  const blockList = blocks.data?.blocks;
  const names = programs.data?.names;
  const dayStart = config?.day_start_utc_hour ?? 12;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !blockList || !inst) return;
    const handle = renderGuide(root, {
      blocks: blockList,
      names: names ?? {},
      dayStartUtcHour: dayStart,
      links: (d, day) => linksFor(inst, d, day),
      dayHref: (day) => dayHrefFor(inst, day),
      rangeHref: (d, day) => rangeHrefFor(inst, d, day),
      onNavigate: (path) => navigate(path),
    });
    return () => handle.dispose();
  }, [blockList, names, inst, dayStart, navigate]);

  if (config && !config.enabled) {
    return (
      <section className="guide-page">
        <h1>Observing guide</h1>
        <p className="guide-notice">
          The observing guide is not configured on this deployment (no ConsDB
          endpoint).
        </p>
      </section>
    );
  }
  if (config && param && !inst) {
    return (
      <section className="guide-page">
        <h1>Observing guide</h1>
        <p className="guide-notice">
          No guide for instrument <code>{param}</code>.{" "}
          <Link to="/guide">Back to the guide</Link>.
        </p>
      </section>
    );
  }

  const status = blocks.data;
  return (
    <section className="guide-page" ref={rootRef}>
      <header className="guide-header">
        <h1>Observing guide</h1>
        {instruments.length > 1 && (
          <nav className="guide-instruments" aria-label="Instrument">
            {instruments.map((i) => (
              <Link
                key={i.name}
                to={`/guide/${i.name}`}
                className={
                  "guide-instrument" + (i.name === name ? " guide-instrument--active" : "")
                }
                aria-current={i.name === name ? "page" : undefined}
              >
                {i.name.toUpperCase()}
              </Link>
            ))}
          </nav>
        )}
        <div className="guide-status" role="status">
          {blocks.isError && <span className="guide-pill guide-pill--bad">Guide unavailable</span>}
          {status?.loading && (
            <span className="guide-pill guide-pill--busy">
              Sweeping ConsDB… {status.exposures.toLocaleString()} exposures so far
            </span>
          )}
          {status && !status.loading && status.error && (
            <span className="guide-pill guide-pill--warn" title={status.error}>
              ConsDB unreachable — showing last known blocks
            </span>
          )}
          {status && !status.loading && !status.error && (
            <span className="guide-pill">
              {status.blocks.length.toLocaleString()} blocks · updated{" "}
              {fmtUpdated(status.updated_at) || "never"}
            </span>
          )}
        </div>
      </header>
      <div className="guide-main">
        <div className="guide-chart-container">
          <div className="guide-chart" />
        </div>
        <aside className="guide-info-container">
          <div className="guide-search-container">
            <input
              type="text"
              className="guide-search-input"
              placeholder="Search programs… (press / or Ctrl+F)"
              autoComplete="off"
              aria-label="Search programs"
            />
            <div className="guide-search-results" style={{ display: "none" }} />
          </div>
          <div className="guide-info-panel empty">
            <h3 className="guide-panel-title">Selection Info</h3>
            <div className="guide-panel-content" />
          </div>
        </aside>
      </div>
      <div className="guide-floating-axis">
        <svg className="guide-floating-axis-svg" />
      </div>
    </section>
  );
}

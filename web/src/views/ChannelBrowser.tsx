import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";
import { usePageTitle } from "../lib/usePageTitle";
import type { ChannelOut } from "../lib/types";

// The Channels tab: a grouped list of the camera's channels (left) + a viewer
// pane (right) describing the selected channel and linking through to its live
// single-exposure view. Ported from the design's ChannelsView (design/from-
// claude/Camera Table - Sidebar v2.html), driven by the real camera config.
//
// The selected channel lives in the URL (?channel=) so a deep link restores the
// pane; "open live view" hands off to the existing /current route.

// Channels split into per-exposure (live) and per-night (movies/day artifacts)
// groups — the backend ships a flat list with a per_day flag rather than named
// groups, so we derive the two the design shows.
function groupChannels(channels: ChannelOut[]): {
  title: string;
  channels: ChannelOut[];
}[] {
  const live = channels.filter((c) => !c.per_day);
  const perDay = channels.filter((c) => c.per_day);
  const groups: { title: string; channels: ChannelOut[] }[] = [];
  if (live.length) groups.push({ title: "Per exposure", channels: live });
  if (perDay.length) groups.push({ title: "Per night", channels: perDay });
  return groups;
}

export function ChannelBrowser() {
  const { location = "", camera = "" } = useParams();
  const [params, setParams] = useSearchParams();

  const { data: cameraInfo, isPending, isError } = useQuery({
    queryKey: queryKeys.camera(location, camera),
    queryFn: () => api.camera(location, camera),
    staleTime: STALE.config,
  });

  usePageTitle(cameraInfo?.title ?? camera, "Channels");

  const channels = useMemo(
    () => (Array.isArray(cameraInfo?.channels) ? cameraInfo.channels : []),
    [cameraInfo],
  );
  const groups = useMemo(() => groupChannels(channels), [channels]);

  // The previewed channel: the URL's ?channel=, else the first available one.
  const focusedName = params.get("channel") ?? channels[0]?.name ?? "";
  const hero = channels.find((c) => c.name === focusedName) ?? channels[0];

  const selectChannel = (name: string) => {
    const next = new URLSearchParams(params);
    next.set("channel", name);
    setParams(next, { replace: true });
  };

  if (isPending) return <p className="skeleton">Loading channels…</p>;
  if (isError) return <p role="alert">Could not load channels.</p>;
  if (channels.length === 0 || !hero)
    return <p className="skeleton">This camera has no channels.</p>;

  const liveHref = `/${location}/${camera}/${hero.name}/current`;

  return (
    <div className="chv-root">
      {/* Left: grouped channel list */}
      <div className="chv-list">
        <div className="chv-list-head">
          <div className="ttl">Channels</div>
          <div className="ct">{channels.length} TOTAL</div>
        </div>
        {groups.map((g) => (
          <div className="chv-group" key={g.title}>
            <div className="chv-group-h">{g.title}</div>
            {g.channels.map((ch) => {
              const active = ch.name === hero.name;
              return (
                <button
                  key={ch.name}
                  type="button"
                  className={`chv-item ${active ? "active" : ""}`}
                  onClick={() => selectChannel(ch.name)}
                  aria-current={active ? "true" : undefined}
                >
                  <span
                    className="sw"
                    style={{ background: ch.colour ?? "var(--line-mid)" }}
                  />
                  <div className="nm-wrap">
                    <div className="nm">{ch.title}</div>
                    <div className="mt">{ch.label}</div>
                  </div>
                  <span className={`tag chv-tag ${ch.per_day ? "" : "live"}`}>
                    {ch.per_day ? "day" : "live"}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Right: viewer pane for the selected channel */}
      <div className="chv-viewer">
        <div className="chv-vhead">
          <span
            className="sw"
            style={{ background: hero.colour ?? "var(--line-mid)" }}
          />
          <h3>{hero.title}</h3>
          <span className={`tag ${hero.per_day ? "" : "live"}`}>
            {hero.per_day ? "per day" : "live"}
          </span>
          <span style={{ flex: 1 }} />
          <span className="meta">{hero.label}</span>
        </div>

        <Link className="ph chv-frame" to={liveHref}>
          open {hero.title}
        </Link>

        <div className="chv-cols">
          <div>
            <div className="chv-section-h">Channel</div>
            <div className="chv-desc">
              {hero.title} —{" "}
              {hero.per_day
                ? "a per-night artifact, stitched across the whole night."
                : "refreshed per exposure as new sequence numbers arrive."}
            </div>
            <div className="chv-actions">
              <Link className="btn btn-active" to={liveHref}>
                ↗ open full-page live view
              </Link>
            </div>
          </div>
          <div>
            <div className="chv-section-h">Details</div>
            <div className="chv-meta-grid">
              <div className="k">name</div>
              <div className="v">{hero.name}</div>
              <div className="k">label</div>
              <div className="v">{hero.label}</div>
              <div className="k">cadence</div>
              <div className="v">{hero.per_day ? "per night" : "per exposure"}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

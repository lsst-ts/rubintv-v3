import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { usePageTitle } from "../lib/usePageTitle";
import type { ChannelOut, DatePayload } from "../lib/types";

// The Channels tab: a responsive grid of latest-frame cards, one per channel,
// each showing that channel's most recent image (or movie, for per-day
// channels) with its title, live/day tag, and seq/age line. Clicking a card
// opens that channel's live single-exposure viewer. Ported from the design's
// "Layout A" (design/from-claude/channels-layouts.jsx) into the current v2
// light design language, driven by the real camera config + date payload.

const VIDEO_EXTS = ["mp4", "webm", "mov"];

interface LatestMedia {
  src: string | null;
  isVideo: boolean;
  // Label for the latest exposure ("786" for a seq, "movie"/"stills" for
  // per-day artifacts).
  seqLabel: string | null;
}

// Resolve a channel's latest media URL from the date payload. Live channels
// take the highest seq present; per-day channels use their raw S3 key.
function latestFor(
  ch: ChannelOut,
  payload: DatePayload | undefined,
  location: string,
  camera: string,
): LatestMedia {
  if (!payload) return { src: null, isVideo: false, seqLabel: null };

  if (ch.per_day) {
    const key = payload.per_day?.[ch.name];
    if (!key) return { src: null, isVideo: false, seqLabel: null };
    const src = api.perDayMediaUrl(location, camera, key);
    const isVideo = VIDEO_EXTS.some((e) => key.toLowerCase().endsWith(e));
    return { src, isVideo, seqLabel: isVideo ? "movie" : "stills" };
  }

  const seqs = (payload.channels?.[ch.name] ?? []).filter(
    (n): n is number => typeof n === "number",
  );
  if (seqs.length === 0) return { src: null, isVideo: false, seqLabel: null };
  const seq = Math.max(...seqs);

  const ext = payload.extensions?.[ch.name];
  const fileExt = ext?.exceptions?.[String(seq)] ?? ext?.default ?? "png";
  const isVideo = VIDEO_EXTS.includes(fileExt);
  const src = api.mediaUrl(
    location,
    camera,
    ch.name,
    payload.date,
    String(seq).padStart(6, "0"),
    `image.${fileExt}`,
  );
  return { src, isVideo, seqLabel: String(seq) };
}

function ChannelCard({
  ch,
  media,
  href,
}: {
  ch: ChannelOut;
  media: LatestMedia;
  href: string;
}) {
  return (
    <Link className="chc-card" to={href}>
      <div className="chc-frame">
        {media.src ? (
          media.isVideo ? (
            <video src={media.src} muted playsInline preload="metadata" />
          ) : (
            <img src={media.src} alt={`${ch.title} latest`} loading="lazy" />
          )
        ) : (
          <div className="chc-empty">no recent frame</div>
        )}
      </div>
      <div className="chc-body">
        <span className="sw" style={{ background: ch.colour ?? "var(--line-mid)" }} />
        <div className="chc-title">{ch.title}</div>
        <span className={`tag chv-tag ${ch.per_day ? "" : "live"}`}>
          {ch.per_day ? "day" : "live"}
        </span>
      </div>
      <div className="chc-foot">
        {media.seqLabel && <span className="chc-seq">{media.seqLabel}</span>}
        <span>{ch.label}</span>
      </div>
    </Link>
  );
}

export function ChannelBrowser() {
  const { location = "", camera = "" } = useParams();

  const { data: cameraInfo, isPending, isError } = useQuery({
    queryKey: queryKeys.camera(location, camera),
    queryFn: () => api.camera(location, camera),
    staleTime: STALE.config,
  });

  usePageTitle(cameraInfo?.title ?? camera, "Channels");

  // The latest day with data drives "latest frame" for every channel.
  const { data: calendar } = useQuery({
    queryKey: queryKeys.calendar(location, camera),
    queryFn: () => api.calendar(location, camera),
    staleTime: STALE.calendar,
  });
  const date = calendar?.dates?.[0] ?? "";

  const { data: payload } = useQuery({
    queryKey: queryKeys.datePayload(location, camera, date),
    queryFn: () => api.datePayload(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  const channels = useMemo(
    () => (Array.isArray(cameraInfo?.channels) ? cameraInfo.channels : []),
    [cameraInfo],
  );
  const live = channels.filter((c) => !c.per_day);
  const perDay = channels.filter((c) => c.per_day);

  if (isPending) return <p className="skeleton">Loading channels…</p>;
  if (isError) return <p role="alert">Could not load channels.</p>;
  if (channels.length === 0)
    return <p className="skeleton">This camera has no channels.</p>;

  const renderGroup = (title: string, list: ChannelOut[]) =>
    list.length > 0 && (
      <section className="chc-group">
        <div className="chc-group-head">
          <h2>{title}</h2>
          <span className="chc-count">{list.length}</span>
        </div>
        <div className="chc-grid">
          {list.map((ch) => (
            <ChannelCard
              key={ch.name}
              ch={ch}
              media={latestFor(ch, payload, location, camera)}
              href={`/${location}/${camera}/${ch.name}/current`}
            />
          ))}
        </div>
      </section>
    );

  return (
    <div className="chc-root">
      {renderGroup("Image channels", live)}
      {renderGroup("Per night", perDay)}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE, staleTimeForDate, currentDayObs } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
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
  // Numeric latest seq for live channels (null for per-day artifacts, which
  // have no comparable sequence). Drives the cross-card staleness cue.
  seq: number | null;
}

// A live card is flagged stale once its latest seq trails the night's frontier
// (the highest seq any live card has reached) by more than this many frames.
// Seqs aren't perfectly comparable across channels with different cadences, so
// the threshold is deliberately loose — the cue should catch a card that has
// clearly fallen behind, not flicker on normal frame-to-frame jitter.
const STALE_SEQ_LAG = 5;

// Resolve a channel's latest media URL from the date payload. Live channels
// take the highest seq present; per-day channels use their raw S3 key.
function latestFor(
  ch: ChannelOut,
  payload: DatePayload | undefined,
  location: string,
  camera: string,
): LatestMedia {
  if (!payload) return { src: null, isVideo: false, seqLabel: null, seq: null };

  if (ch.per_day) {
    const seqSeg = payload.per_day?.[ch.name];
    if (!seqSeg) return { src: null, isVideo: false, seqLabel: null, seq: null };
    const fileExt = payload.extensions?.[ch.name]?.default ?? "mp4";
    const src = api.perDayMediaUrl(
      location,
      camera,
      ch.name,
      payload.date,
      seqSeg,
      fileExt,
    );
    const isVideo = VIDEO_EXTS.includes(fileExt);
    return { src, isVideo, seqLabel: isVideo ? "movie" : "stills", seq: null };
  }

  const seqs = (payload.channels?.[ch.name] ?? []).filter(
    (n): n is number => typeof n === "number",
  );
  if (seqs.length === 0)
    return { src: null, isVideo: false, seqLabel: null, seq: null };
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
  return { src, isVideo, seqLabel: String(seq), seq };
}

function ChannelCard({
  ch,
  media,
  href,
  lag,
  lastDate,
}: {
  ch: ChannelOut;
  media: LatestMedia;
  href: string;
  // How many frames this live card trails the night's frontier by, or null
  // when staleness doesn't apply (per-day card, no frame yet, or no frontier).
  lag: number | null;
  // The channel's most recent date with data when it has no frame on the
  // grid's day, so the empty placeholder names where its last plot is (the
  // card links there). Null when the channel has never had data.
  lastDate: string | null;
}) {
  const stale = lag !== null && lag > STALE_SEQ_LAG;
  // While the card's image is still loading the browser paints it top-down; dim
  // it and show a spinner until it's done so the card reads as "loading" rather
  // than half-drawn. The card is keyed by channel name (not src), so it does
  // NOT remount on a live frame swap — re-arm the loading state whenever
  // media.src changes; an already cached image (img.complete in the ref) clears
  // it without a flash.
  const [imgLoaded, setImgLoaded] = useState(false);
  useEffect(() => setImgLoaded(false), [media.src]);
  const imgRef = (el: HTMLImageElement | null) => {
    if (el?.complete) setImgLoaded(true);
  };
  return (
    <Link className={`chc-card${stale ? " chc-card--stale" : ""}`} to={href}>
      <div className="chc-frame">
        {media.src ? (
          media.isVideo ? (
            <video src={media.src} muted playsInline preload="metadata" />
          ) : (
            <>
              <img
                ref={imgRef}
                src={media.src}
                alt={`${ch.title} latest`}
                loading="lazy"
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgLoaded(true)}
                className={imgLoaded ? undefined : "chc-img-loading"}
              />
              {!imgLoaded && (
                <div
                  className="chc-img-spinner"
                  role="status"
                  aria-label="Loading image"
                >
                  <span className="chv-spinner" />
                </div>
              )}
            </>
          )
        ) : lastDate ? (
          <div className="chc-empty">
            <span className="chc-empty-label">last frame</span>
            <span className="chc-empty-date">{lastDate}</span>
          </div>
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
        {stale && (
          <span className="chc-lag" title={`${lag} frames behind the latest channel`}>
            −{lag}
          </span>
        )}
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

  // Subscribe to this camera's live topic so new exposures advance the cards
  // without a reload — the same subscription the table and single-channel
  // views use. A channelData message invalidates the date payload below, which
  // re-resolves each card's latest frame. Without this the grid froze on its
  // first fetch while the table (which does subscribe) kept updating.
  useLiveTopic(date ? { topic: "camera", location, camera, date } : null);

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

  // Whether the day these cards are drawn from is the live observing day.
  // The cards always show the newest day with data (calendar.dates[0]); if
  // that isn't the current day_obs, the grid is an older night, not "now".
  const isCurrentDayObs = date !== "" && date === currentDayObs();

  // The night's frontier: the highest latest-seq any live card has reached.
  // Per-day cards carry no comparable seq, so they're excluded from both the
  // frontier and the staleness cue.
  const frontier = Math.max(
    0,
    ...live.map((ch) => latestFor(ch, payload, location, camera).seq ?? 0),
  );

  // Per-channel last-known date, supplied by the calendar so an empty card
  // can deep-link without scanning older payloads client-side.
  const channelLatest = calendar?.channel_latest ?? {};

  // An empty card's last-known date: the channel's most recent date with data
  // when it has none on the grid's day. Null when it has a frame today or has
  // never had data (so the card reads "no recent frame", not a stale date).
  const lastDateFor = (ch: ChannelOut, media: LatestMedia) => {
    if (media.src) return null;
    const last = channelLatest[ch.name];
    return last && last !== date ? last : null;
  };

  // Where a card links. A card with a frame on the grid's day opens the live
  // view (follows the newest exposure). A live card with *no* frame today but
  // data on an earlier day links straight to that day's last plot — a bare
  // ?date= (no seq) which the viewer resolves to the newest seq there. Per-day
  // channels stay on /current: the seq-based viewer can't render their
  // artifacts, so there's no better fixed target.
  const hrefFor = (ch: ChannelOut, media: LatestMedia) => {
    const current = `/${location}/${camera}/${ch.name}/current`;
    const last = lastDateFor(ch, media);
    if (!last || ch.per_day) return current;
    return `/${location}/${camera}/${ch.name}?date=${last}`;
  };

  const renderGroup = (title: string, list: ChannelOut[]) =>
    list.length > 0 && (
      <section className="chc-group">
        <div className="chc-group-head">
          <h2>{title}</h2>
          <span className="chc-count">{list.length}</span>
        </div>
        <div className="chc-grid">
          {list.map((ch) => {
            const media = latestFor(ch, payload, location, camera);
            // Lag only applies once we have a frontier and this card has a seq.
            const lag =
              media.seq !== null && frontier > 0 ? frontier - media.seq : null;
            return (
              <ChannelCard
                key={ch.name}
                ch={ch}
                media={media}
                href={hrefFor(ch, media)}
                lastDate={lastDateFor(ch, media)}
                lag={lag}
              />
            );
          })}
        </div>
      </section>
    );

  return (
    <div className="chc-root">
      {date !== "" && (
        <div
          className={`chc-dayobs${isCurrentDayObs ? " chc-dayobs--live" : " chc-dayobs--past"}`}
        >
          <span className="chc-dayobs-dot" aria-hidden="true" />
          {isCurrentDayObs ? (
            <span>
              Showing <strong>tonight</strong> · {date}
            </span>
          ) : (
            <span>
              Latest data is from <strong>{date}</strong> — not the current
              observing day
            </span>
          )}
        </div>
      )}
      {renderGroup("Image channels", live)}
      {renderGroup("Per night", perDay)}
    </div>
  );
}

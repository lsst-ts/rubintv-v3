import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { usePageTitle } from "../lib/usePageTitle";
import { DownloadMovieLink } from "../components/DownloadMovieLink";
import {
  JumpToCurrentIcon,
  RangeArrowIcon,
  ViewerIcon,
} from "../components/Icons";
import { ProxiedImg, ProxiedVideo } from "../components/ProxiedMedia";

// Viewer for a per-day channel (e.g. Tonight's Movie): one artifact per night,
// browsed night by night. Laid out like All Sky's historical day — the movie
// fitted to the stage under a caption, no metadata sidebar (there's no single
// exposure to describe). Nights are picked with the shell's date picker and
// steppers, which on this page range over the nights that have this channel's
// artifact (the calendar's per_day_dates) and stay in this view — see
// useShellNav's perDayChannel.
//
// Two modes, as in the seq viewer:
//   * Fixed (?date=): that night's artifact.
//   * Live ("/current"): the channel's newest night. A perDay live message
//     refreshes the calendar, so the next night's movie replaces it in place.
//     Picking a night links to the fixed URL, dropping out of live mode.

const VIDEO_EXTS = ["mp4", "webm", "mov"];

export function PerDayChannel({ live }: { live: boolean }) {
  const { location = "", camera = "", channel = "" } = useParams();
  const [params] = useSearchParams();

  const { data: cameraInfo } = useQuery({
    queryKey: queryKeys.camera(location, camera),
    queryFn: () => api.camera(location, camera),
    staleTime: STALE.config,
  });
  const { data: calendar } = useQuery({
    queryKey: queryKeys.calendar(location, camera),
    queryFn: () => api.calendar(location, camera),
    staleTime: STALE.calendar,
  });

  const nights = calendar?.per_day_dates?.[channel] ?? [];
  const date = live ? (nights[0] ?? "") : (params.get("date") ?? "");

  const channelInfo = cameraInfo?.channels?.find((c) => c.name === channel);
  const title = channelInfo?.title ?? channel;
  usePageTitle(
    `${cameraInfo?.title ?? camera} / ${channel}`,
    live ? "LIVE" : date || undefined,
  );

  useLiveTopic(date ? { topic: "camera", location, camera, date } : null);

  const { data: payload } = useQuery({
    queryKey: queryKeys.datePayload(location, camera, date),
    queryFn: () => api.datePayload(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  // The night's artifact. The entry carries its own extension; the channel
  // default is only a fallback for an index written before that was recorded.
  const ref = payload?.per_day?.[channel];
  const ext = ref ? ref.ext || payload?.extensions?.[channel]?.default || "mp4" : "";
  const src = ref
    ? api.perDayMediaUrl(location, camera, channel, date, ref.seq, ext)
    : "";
  const isVideo = VIDEO_EXTS.includes(ext);

  // The night's exposures (every integer seq on any channel), captioned as a
  // range linking to that night's table — context for what the movie spans.
  const seqs = new Set<number>();
  for (const list of Object.values(payload?.channels ?? {})) {
    for (const s of list) if (typeof s === "number") seqs.add(s);
  }
  const first = seqs.size > 0 ? Math.min(...seqs) : null;
  const last = seqs.size > 0 ? Math.max(...seqs) : null;

  const empty =
    live && calendar && nights.length === 0
      ? `No ${title} yet.`
      : date && payload && !ref
        ? `No ${title} for ${date}.`
        : null;

  return (
    <section className="perday-view">
      <header className="chv-vhead channel-head">
        <span
          className="sw"
          style={{ background: channelInfo?.colour ?? "var(--line-mid)" }}
        />
        <h3>
          {cameraInfo?.title ?? camera} / {channel}
        </h3>
        {live && (
          <span className="tag live live-badge" role="status">
            LIVE
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!live && (
          <nav className="seq-nav">
            <Link
              className="seq-arrow seq-jump"
              to={`/${location}/${camera}/${channel}/current`}
              title="Jump to current"
              aria-label="Jump to current"
            >
              <JumpToCurrentIcon />
            </Link>
          </nav>
        )}
      </header>

      <div className="media-stage media-stage--fit">
        {empty && <p className="skeleton">{empty}</p>}
        {src && (
          // The cell is the size container the media caps itself against.
          <div className="media-cell">
            <figure className="media-col">
              <figcaption className="media-head">
                {first !== null && (
                  <Link
                    className="amh-action amh-range"
                    to={`/${location}/${camera}?date=${date}`}
                    title={`${seqs.size} exposures on ${date}: open the night in the table`}
                  >
                    Exposures #{first}
                    <RangeArrowIcon />#{last}
                  </Link>
                )}
                <span className="amh-end">
                  {isVideo ? (
                    <DownloadMovieLink src={src} showLabel />
                  ) : (
                    <a
                      className="amh-action"
                      href={src}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open image in new tab"
                      aria-label="Open image in new tab"
                    >
                      <ViewerIcon />
                    </a>
                  )}
                </span>
              </figcaption>
              <div className="media-frame">
                {isVideo ? (
                  // Loop like All Sky's movie. autoPlay needs muted to be
                  // allowed by browser policy; playsInline keeps it from
                  // going fullscreen on mobile.
                  <ProxiedVideo src={src} controls loop autoPlay muted playsInline />
                ) : (
                  <ProxiedImg src={src} alt={`${channel} ${date}`} />
                )}
              </div>
            </figure>
          </div>
        )}
      </div>
    </section>
  );
}

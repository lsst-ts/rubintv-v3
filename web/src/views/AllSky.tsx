import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { usePageTitle } from "../lib/usePageTitle";

// Live view (live_view cameras, e.g. All Sky): a single panel showing the most
// recent movie and (on the current date) the latest still, rather than a
// per-seq-num table. Despite the channels being flagged per_day in config, the
// bucket stores them as ordinary per-seq-num artifacts (integer seqs under
// payload.channels).
//
// Two modes, keyed off whether the date is the newest one in the calendar:
//
//   * Current date: live. Show the latest still AND the latest movie, each at
//     its highest integer seq. A channelData live message invalidates the date
//     payload so the panel advances to a newer seq in place, no reload.
//
//   * Historical date: movie only. The last movie written for a finished day
//     carries the "final" sentinel seq (.../movies/final/...), so we request
//     that directly through the proxy — which resolves it by S3 prefix and so
//     does NOT depend on the index/cache, which may be incomplete if the
//     poller was interrupted before the final movie was recorded. Stills are
//     not shown for past days.
export function AllSky() {
  const { location = "", camera = "" } = useParams();
  const [params, setParams] = useSearchParams();

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
  const date = params.get("date") ?? calendar?.dates[0] ?? "";
  // The newest date with data is the live one; everything else is historical.
  const isCurrent = date !== "" && date === calendar?.dates[0];
  usePageTitle(cameraInfo?.title ?? camera, date);

  // Subscribe with the resolved date so channelData updates for today land live.
  useLiveTopic(date ? { topic: "camera", location, camera, date } : null);

  const { data: payload } = useQuery({
    queryKey: queryKeys.datePayload(location, camera, date),
    queryFn: () => api.datePayload(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  // Channels declared as video in the camera's mosaic view are "movie"
  // channels; the rest (stills) render as images.
  const videoChannels = useMemo(
    () =>
      new Set(
        cameraInfo?.mosaic_view_meta
          .filter((m) => m.media_type === "video")
          .map((m) => m.channel) ?? [],
      ),
    [cameraInfo],
  );

  const tiles = useMemo<Tile[]>(() => {
    if (!cameraInfo) return [];

    return cameraInfo.channels.flatMap((ch): Tile[] => {
      const isVideo = videoChannels.has(ch.name);

      // Historical: movie channels resolve to the "final" sentinel directly,
      // bypassing the (possibly incomplete) index. Stills are skipped.
      if (!isCurrent) {
        if (!isVideo) return [];
        return [
          {
            channel: ch.name,
            title: ch.title,
            seq: "final",
            isVideo: true,
            src: api.mediaUrl(location, camera, ch.name, date, "final", "movie.mp4"),
          },
        ];
      }

      // Current date: latest artifact at the highest integer seq.
      if (!payload) return [];
      const seqs = (payload.channels[ch.name] ?? []).filter(
        (n): n is number => typeof n === "number",
      );
      if (seqs.length === 0) return [];
      const seq = Math.max(...seqs);
      const ext =
        payload.extensions[ch.name]?.exceptions?.[String(seq)] ??
        payload.extensions[ch.name]?.default ??
        (isVideo ? "mp4" : "png");
      return [
        {
          channel: ch.name,
          title: ch.title,
          seq,
          isVideo,
          src: api.mediaUrl(
            location,
            camera,
            ch.name,
            date,
            String(seq).padStart(6, "0"),
            `image.${ext}`,
          ),
        },
      ];
    });
  }, [cameraInfo, payload, videoChannels, isCurrent, location, camera, date]);

  return (
    <section className="live-view allsky-wrap">
      {/* Toolbar: historical-date picker + live/historical indicator. */}
      <div className="allsky-toolbar">
        <span className="amovie-label">All-sky feed</span>
        <select
          className="date-field"
          value={date}
          aria-label="Date"
          onChange={(e) => setParams({ date: e.target.value })}
        >
          {calendar?.dates.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        {isCurrent ? (
          <span className="tag live">live</span>
        ) : (
          <span className="tag">historical · {date}</span>
        )}
      </div>

      <div className="allsky-stage live-view-media">
        {tiles.length === 0 && date !== "" && (
          <p className="skeleton">No imagery yet for {date}.</p>
        )}
        {tiles.map((t) => (
          <figure key={t.channel} className="allsky-col live-view-item">
            <figcaption className="allsky-mediahead">
              <span className="amh-title">{t.title}</span>
              <span className="amh-meta live-view-seq">
                {typeof t.seq === "number" ? `#${t.seq}` : t.seq}
              </span>
            </figcaption>
            <div className="allsky-frame">
              {t.isVideo ? (
                <video src={t.src} controls />
              ) : (
                <img src={t.src} alt={`${t.title} ${t.seq}`} />
              )}
            </div>
          </figure>
        ))}
      </div>
    </section>
  );
}

interface Tile {
  channel: string;
  title: string;
  seq: number | string;
  isVideo: boolean;
  src: string;
}

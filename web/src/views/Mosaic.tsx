import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { usePageTitle } from "../lib/usePageTitle";
import type { Metadata } from "../lib/types";

// Live mosaic: a grid of channels, each tile showing that channel's *latest*
// plot beside a few chosen metadata values for the same exposure. Built for
// embedding as an <iframe> (pair it with ?headerless=true on the URL, handled
// by Layout) so another app can surface a compact, self-updating panel.
//
// Tiles are driven by the camera's mosaic_view_meta: each entry names a
// channel, whether it renders as image/video, and which metadata columns to
// show. The tile always follows the newest date and the highest integer seq —
// there's no date picker — and a channelData live message invalidates the date
// payload so a tile advances to a newer seq in place, no reload. This mirrors
// the latest-seq resolution AllSky uses.
export function Mosaic() {
  const { location = "", camera = "" } = useParams();
  const qc = useQueryClient();
  usePageTitle("Mosaic / Movies", camera);

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
  // Always the newest date with data — the mosaic is live-only.
  const date = calendar?.dates[0] ?? "";

  // Subscribe with the live date so channelData updates land in place.
  useLiveTopic(date ? { topic: "camera", location, camera, date } : null);

  const { data: payload } = useQuery({
    queryKey: queryKeys.datePayload(location, camera, date),
    queryFn: () => api.datePayload(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  // Metadata for the chosen columns: streamed rows merged with the REST
  // backstop, exactly as the table does — the stream usually arrives first,
  // REST fills any dropped chunk (and covers clients with no stream).
  const streamKey = queryKeys.metadataStream(location, camera, date);
  const { data: streamedMeta } = useQuery<Metadata>({
    queryKey: streamKey,
    queryFn: () => qc.getQueryData<Metadata>(streamKey) ?? {},
    staleTime: Infinity,
  });
  const { data: restMeta } = useQuery<Metadata>({
    queryKey: queryKeys.metadata(location, camera, date),
    queryFn: () => api.metadata(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });
  const metadata = useMemo<Metadata>(
    () => ({ ...(streamedMeta ?? {}), ...(restMeta ?? {}) }),
    [streamedMeta, restMeta],
  );

  // Channel title lookup, so a tile can label itself from config.
  const channelTitle = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of cameraInfo?.channels ?? []) m[c.name] = c.title;
    return m;
  }, [cameraInfo]);

  const tiles = useMemo<Tile[]>(() => {
    if (!cameraInfo || !payload) return [];
    return cameraInfo.mosaic_view_meta.flatMap((entry): Tile[] => {
      const isVideo = entry.media_type === "video";
      const seqs = (payload.channels[entry.channel] ?? []).filter(
        (n): n is number => typeof n === "number",
      );
      if (seqs.length === 0) return [];
      const seq = Math.max(...seqs);
      const ext =
        payload.extensions[entry.channel]?.exceptions?.[String(seq)] ??
        payload.extensions[entry.channel]?.default ??
        (isVideo ? "mp4" : "png");
      const row = metadata[String(seq)] ?? {};
      return [
        {
          channel: entry.channel,
          title: channelTitle[entry.channel] ?? entry.channel,
          seq,
          isVideo,
          src: api.mediaUrl(
            location,
            camera,
            entry.channel,
            date,
            String(seq).padStart(6, "0"),
            `image.${ext}`,
          ),
          meta: entry.meta_columns.map((col) => ({
            label: col,
            value: formatMetaValue(row[col]),
          })),
        },
      ];
    });
  }, [cameraInfo, payload, metadata, channelTitle, location, camera, date]);

  return (
    <section className="mosaic-view">
      <div className="mosaic-grid card-grid">
        {tiles.length === 0 && date !== "" && (
          <p className="skeleton">No imagery yet for {date}.</p>
        )}
        {tiles.map((t) => (
          <figure key={t.channel} className="mosaic-tile card">
            <figcaption className="mosaic-tilehead">
              <span className="mosaic-title">{t.title}</span>
              <span className="mosaic-seq">#{t.seq}</span>
            </figcaption>
            <div className="mosaic-frame">
              {t.isVideo ? (
                <video src={t.src} controls loop autoPlay muted playsInline />
              ) : (
                <img src={t.src} alt={`${t.title} ${t.seq}`} loading="lazy" />
              )}
            </div>
            {t.meta.length > 0 && (
              <dl className="mosaic-meta">
                {t.meta.map((m) => (
                  <div key={m.label} className="mosaic-meta-row">
                    <dt>{m.label}</dt>
                    <dd>{m.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </figure>
        ))}
      </div>
    </section>
  );
}

// Metadata values come through untyped (Record<string, unknown>); render them
// safely. Objects fall back to "—" rather than "[object Object]".
function formatMetaValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "object") return "—";
  return String(value);
}

interface Tile {
  channel: string;
  title: string;
  seq: number;
  isVideo: boolean;
  src: string;
  meta: { label: string; value: string }[];
}

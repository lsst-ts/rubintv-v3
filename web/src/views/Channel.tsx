import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import type { Metadata } from "../lib/types";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";

// Single-channel image/video view with prev/next seq navigation and a
// metadata sidebar. Subscribes to the camera topic for live updates.
export function Channel() {
  const { location = "", camera = "", channel = "" } = useParams();
  const [params] = useSearchParams();
  const date = params.get("date") ?? "";
  const seq = Number(params.get("seq") ?? "0");

  useLiveTopic({ topic: "camera", location, camera });

  const { data: cameraInfo } = useQuery({
    queryKey: queryKeys.camera(location, camera),
    queryFn: () => api.camera(location, camera),
    staleTime: STALE.config,
  });

  const { data: payload } = useQuery({
    queryKey: queryKeys.datePayload(location, camera, date),
    queryFn: () => api.datePayload(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  // Metadata is fetched separately from the structured payload (shares the
  // cache with the table's query) so the media renders without waiting on it.
  const { data: metadata } = useQuery<Metadata>({
    queryKey: queryKeys.metadata(location, camera, date),
    queryFn: () => api.metadata(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  const seqs = useMemo(() => {
    const present = (payload?.channels[channel] ?? []).filter(
      (n): n is number => typeof n === "number",
    );
    return present.sort((a, b) => a - b);
  }, [payload, channel]);

  const idx = seqs.indexOf(seq);
  const prev = idx > 0 ? seqs[idx - 1] : null;
  const next = idx >= 0 && idx < seqs.length - 1 ? seqs[idx + 1] : null;

  const ext = payload?.extensions[channel];
  const fileExt = ext?.exceptions?.[String(seq)] ?? ext?.default ?? "png";
  const isVideo = ["mp4", "webm", "mov"].includes(fileExt);
  const mediaFor = (s: number) =>
    api.mediaUrl(
      location,
      camera,
      channel,
      date,
      String(s).padStart(6, "0"),
      `image.${fileExt}`,
    );
  const src = date && seq ? mediaFor(seq) : "";

  const navTo = (s: number) =>
    `/${location}/${camera}/${channel}?seq=${s}&date=${date}`;

  const navigate = useNavigate();

  // Arrow-key navigation between sequence numbers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && prev !== null) navigate(navTo(prev));
      if (e.key === "ArrowRight" && next !== null) navigate(navTo(next));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prev, next, date]);

  // Preload neighbouring images for instant prev/next (skip videos).
  useEffect(() => {
    if (isVideo) return;
    for (const s of [prev, next]) {
      if (s !== null) {
        const img = new Image();
        img.src = mediaFor(s);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prev, next, isVideo]);

  return (
    <section className="channel-view">
      <header className="table-header">
        <h1>
          {cameraInfo?.title ?? camera} / {channel}
        </h1>
        <nav className="seq-nav">
          {prev !== null ? <Link to={navTo(prev)}>← {prev}</Link> : <span>←</span>}
          <span className="seq-current">{seq}</span>
          {next !== null ? <Link to={navTo(next)}>{next} →</Link> : <span>→</span>}
        </nav>
      </header>

      <div className="media">
        {src &&
          (isVideo ? (
            <video src={src} controls />
          ) : (
            <img src={src} alt={`${channel} ${seq}`} />
          ))}
      </div>

      <aside className="metadata-sidebar">
        <h2>Metadata</h2>
        <dl>
          {Object.entries(metadata?.[String(seq)] ?? {}).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
        {cameraInfo?.image_viewer_link && (
          <a href={cameraInfo.image_viewer_link} target="_blank" rel="noreferrer">
            Open in image viewer
          </a>
        )}
      </aside>
    </section>
  );
}

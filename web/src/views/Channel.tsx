import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import type { Metadata } from "../lib/types";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";

// Single-channel image/video view with prev/next seq navigation and a
// metadata sidebar. Subscribes to the camera topic for live updates.
//
// Two modes:
//   * Fixed (default route, ?seq=&date=): shows exactly that exposure.
//   * Live ("/current" route): follows the latest exposure. The date resolves
//     to the newest calendar date and the seq to the highest in that date's
//     payload, so a channelData live message — which invalidates the payload —
//     advances the image in place without touching the (stable) URL. Any
//     prev/next/table navigation links to a concrete ?seq=&date= URL, dropping
//     out of live mode.
export function Channel({ live = false }: { live?: boolean }) {
  const { location = "", camera = "", channel = "" } = useParams();
  const [params] = useSearchParams();
  const qc = useQueryClient();

  const { data: cameraInfo } = useQuery({
    queryKey: queryKeys.camera(location, camera),
    queryFn: () => api.camera(location, camera),
    staleTime: STALE.config,
  });

  // In live mode the date isn't in the URL — resolve it to the newest date
  // with data. The fixed route always carries an explicit date.
  const { data: calendar } = useQuery({
    queryKey: queryKeys.calendar(location, camera),
    queryFn: () => api.calendar(location, camera),
    staleTime: STALE.calendar,
    enabled: live,
  });
  const date = live
    ? (calendar?.dates[0] ?? "")
    : (params.get("date") ?? "");

  // Subscribe with the resolved date so the server streams this date's metadata
  // (metadataChunk frames) — subscribing without a date starts no stream, so
  // new seqs' rows would never arrive live.
  useLiveTopic(date ? { topic: "camera", location, camera, date } : null);

  const { data: payload } = useQuery({
    queryKey: queryKeys.datePayload(location, camera, date),
    queryFn: () => api.datePayload(location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  // Metadata for the sidebar, composed like the table: the streamed rows
  // (accumulated from metadataChunk frames into this dedicated cache slot)
  // merged with the REST metadata.json backstop. The stream surfaces new seqs'
  // rows live; REST fills any dropped chunk and covers a refetch after a
  // metadata-update live message invalidates it.
  const streamKey = queryKeys.metadataStream(location, camera, date);
  const { data: streamedMeta } = useQuery<Metadata>({
    queryKey: streamKey,
    queryFn: () => qc.getQueryData<Metadata>(streamKey) ?? {},
    staleTime: Infinity,
    enabled: date !== "",
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

  const seqs = useMemo(() => {
    const present = (payload?.channels[channel] ?? []).filter(
      (n): n is number => typeof n === "number",
    );
    return present.sort((a, b) => a - b);
  }, [payload, channel]);

  // The newest exposure available. Live mode follows it; fixed mode pins the
  // URL's seq. seqs is ascending, so the last element is the newest.
  const targetSeq = live
    ? (seqs.length > 0 ? seqs[seqs.length - 1] : 0)
    : Number(params.get("seq") ?? "0");

  const ext = payload?.extensions[channel];
  const fileExtFor = (s: number) =>
    ext?.exceptions?.[String(s)] ?? ext?.default ?? "png";
  const mediaFor = (s: number) =>
    api.mediaUrl(
      location,
      camera,
      channel,
      date,
      String(s).padStart(6, "0"),
      `image.${fileExtFor(s)}`,
    );

  const isVideoFor = (s: number) =>
    ["mp4", "webm", "mov"].includes(fileExtFor(s));

  // In live mode the payload can advance to a new seq before its image has
  // finished downloading and painting. If we showed the new seq immediately,
  // the visible image would still be the old one while the seq label and
  // prev/next links already pointed at the new exposure — so the back arrow
  // would look like it links to the image on screen.
  //
  // The latch: render the *loaded* seq (image + label + links always in lock
  // step), and promote to a newer target only after decoding its bitmap with
  // img.decode(), which resolves when the frame is ready to paint without
  // flicker. onLoad alone isn't enough — it can fire a paint before the swap,
  // and preloaded images fire it near-instantly. Videos have no decode step,
  // so they promote as soon as the target changes.
  const [loadedSeq, setLoadedSeq] = useState<number | null>(null);

  useEffect(() => {
    if (!live || targetSeq === 0) return;
    if (loadedSeq === targetSeq) return;
    if (isVideoFor(targetSeq)) {
      setLoadedSeq(targetSeq);
      return;
    }
    let cancelled = false;
    const promote = () => {
      if (!cancelled) setLoadedSeq(targetSeq);
    };
    const img = new Image();
    img.src = mediaFor(targetSeq);
    if (typeof img.decode === "function") {
      // decode() resolves when the bitmap is paint-ready; rejects on a
      // stale/aborted src — either way we then promote (the load may simply
      // have raced ahead). Preferred path: no flash between link and image.
      img.decode().then(promote, promote);
    } else {
      // Environments without decode() (e.g. jsdom): fall back to load/error.
      img.onload = promote;
      img.onerror = promote;
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, targetSeq]);

  // The displayed seq: in live mode the latched (loaded) one until the next
  // decodes; before the first decode there's nothing to hold back, so show the
  // target. Fixed mode shows the URL seq directly.
  const seq = live
    ? (loadedSeq ?? targetSeq)
    : targetSeq;

  const idx = seqs.indexOf(seq);
  const prev = idx > 0 ? seqs[idx - 1] : null;
  // The payload (and so seqs) grows the instant a new exposure lands, but in
  // live mode the displayed seq is held back until its image decodes. Navigate
  // against the *displayed* frontier, not the raw payload, so a "next" link
  // doesn't appear before the image it points at is on screen. seqs is
  // ascending, so anything after idx is newer than what's shown; suppress it
  // while we're following live (the latch will advance seq, then next reveals).
  // While live and still catching up to the newest target (its image is
  // decoding), suppress "next" so it can't reveal the not-yet-shown frame.
  // Once the latch promotes seq to targetSeq, this is the newest seq and there
  // is no next anyway — so the link only ever appears after a manual step back.
  const hasNewer = idx >= 0 && idx < seqs.length - 1;
  const catchingUp = live && seq !== targetSeq;
  const next = hasNewer && !catchingUp ? seqs[idx + 1] : null;

  const isVideo = isVideoFor(seq);
  const src = date && seq ? mediaFor(seq) : "";

  // The image_viewer_link in config is a template with Python-style format
  // placeholders, e.g. ".../view.html?image=AT_O_{dayObs}_{seqNum:06}&...".
  // Fill {dayObs} (date as an 8-digit YYYYMMDD integer) and {seqNum} (the seq,
  // honouring an optional :0N zero-pad spec). Done here so a moved seq updates
  // the link in lock step with the displayed image.
  const imageViewerHref = useMemo(() => {
    const tmpl = cameraInfo?.image_viewer_link;
    if (!tmpl || !date || !seq) return null;
    const dayObs = date.replace(/-/g, "");
    return tmpl.replace(/\{(dayObs|seqNum)(?::0(\d+))?\}/g, (_m, name, pad) => {
      const value = name === "dayObs" ? dayObs : String(seq);
      return pad ? value.padStart(Number(pad), "0") : value;
    });
  }, [cameraInfo?.image_viewer_link, date, seq]);

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
        {live ? (
          <span className="live-badge" role="status">
            ● LIVE
          </span>
        ) : (
          <Link className="live-link" to={`/${location}/${camera}/${channel}/current`}>
            Jump to current
          </Link>
        )}
      </header>

      <div className="media">
        {src &&
          (isVideo ? (
            <video src={src} controls />
          ) : (
            // src is the latched seq, decoded before promotion (see loadedSeq),
            // so the image, seq label, and prev/next links all change together.
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
        {imageViewerHref && (
          <a href={imageViewerHref} target="_blank" rel="noreferrer">
            Open in image viewer
          </a>
        )}
      </aside>
    </section>
  );
}

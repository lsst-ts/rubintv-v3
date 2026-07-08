import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import type { Metadata } from "../lib/types";
import { STALE, staleTimeForDate } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { usePageTitle } from "../lib/usePageTitle";
import { cellFlagClass } from "../lib/metaCells";
import { usePersistentToggle } from "../lib/usePersistentToggle";
import { DownloadIcon, ChevronDownIcon } from "../components/Icons";

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

  // Metadata sidebar collapse, remembered globally across channels/sessions.
  const [metaCollapsed, setMetaCollapsed] = usePersistentToggle(
    "rubintv.channel.metaCollapsed",
    false,
  );

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
  // A fixed link with a date but no seq (how the channel grid links a card
  // whose channel has no frame on the newest day — straight to its last known
  // plot) resolves to that date's newest seq, same as live mode would.
  const newestSeq = seqs.length > 0 ? seqs[seqs.length - 1] : 0;
  const targetSeq = live
    ? newestSeq
    : params.has("seq")
      ? Number(params.get("seq"))
      : newestSeq;

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

  usePageTitle(
    `${cameraInfo?.title ?? camera} / ${channel}`,
    live ? "LIVE" : seq ? `#${seq}` : undefined,
  );
  const next = hasNewer && !catchingUp ? seqs[idx + 1] : null;

  const isVideo = isVideoFor(seq);
  const src = date && seq ? mediaFor(seq) : "";

  // In fixed mode a prev/next/sibling link changes the seq (and so src) at once,
  // but the <img> keeps painting the previously decoded frame until the new one
  // loads — so the header/seq label can describe an image that isn't on screen
  // yet. Track whether the current src has finished loading and overlay a
  // spinner while it hasn't, so the swap is unmistakable. Live mode already
  // latches the displayed seq to a decoded frame, so it needs no spinner.
  const [imgLoaded, setImgLoaded] = useState(false);
  // Reset to "loading" whenever the source changes; an already-cached image
  // will complete near-instantly (handled below) so the spinner won't flash.
  useEffect(() => {
    setImgLoaded(false);
  }, [src]);
  // Cached images can already be complete before React attaches onLoad, which
  // would then never fire — mark loaded immediately in that case.
  const imgRef = (el: HTMLImageElement | null) => {
    if (el?.complete) setImgLoaded(true);
  };
  const showSpinner = !isVideo && src !== "" && !imgLoaded;

  const navTo = (s: number) =>
    `/${location}/${camera}/${channel}?seq=${s}&date=${date}`;

  const navigate = useNavigate();

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

  const channelInfo = cameraInfo?.channels?.find((c) => c.name === channel);

  // Sibling channels offering the same exposure: every configured channel whose
  // payload lists this seq on this date (the current channel included, shown as
  // the active item). Ordered by the camera's channel config so the strip reads
  // the same as the table's channel columns. Each links to the same seq+date in
  // that channel, dropping out of live mode like every other nav here.
  const siblingChannels = useMemo(
    () =>
      (cameraInfo?.channels ?? []).filter((c) =>
        (payload?.channels[c.name] ?? []).includes(seq),
      ),
    [cameraInfo, payload, seq],
  );

  // The sibling channels either side of the current one, for shift-arrow
  // stepping through the channels that share this exposure. Null at the ends
  // (no wraparound), mirroring the seq nav's boundary behaviour.
  const chanNavTo = (name: string) =>
    `/${location}/${camera}/${name}?seq=${seq}&date=${date}`;
  const chanIdx = siblingChannels.findIndex((c) => c.name === channel);
  const prevChan =
    chanIdx > 0 ? siblingChannels[chanIdx - 1].name : null;
  const nextChan =
    chanIdx >= 0 && chanIdx < siblingChannels.length - 1
      ? siblingChannels[chanIdx + 1].name
      : null;

  // Arrow-key navigation. Plain arrows step the seq back/forward; shift-arrows
  // step through the other channels available for this seq.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey) {
        if (e.key === "ArrowLeft" && prevChan !== null)
          navigate(chanNavTo(prevChan));
        if (e.key === "ArrowRight" && nextChan !== null)
          navigate(chanNavTo(nextChan));
        return;
      }
      if (e.key === "ArrowLeft" && prev !== null) navigate(navTo(prev));
      if (e.key === "ArrowRight" && next !== null) navigate(navTo(next));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prev, next, prevChan, nextChan, date, seq]);

  // Sidebar rows for the displayed exposure. Mirror the table's conventions:
  //   * Drop object/array values — they're foldout-only in the table and have
  //     no inline form here, so showing "[object Object]" is noise.
  //   * Drop "_"/"@"-prefixed keys as their own rows; the "_<col>" entries are
  //     per-cell colour indicators (consumed below), "@<col>" are empty-channel
  //     replacements that aren't real metadata.
  //   * Each remaining value carries the cell-colour class named by its
  //     matching "_<col>" indicator, so the value text gets the same band/flag
  //     background the table cell would.
  const row = (metadata?.[String(seq)] ?? {}) as Record<string, unknown>;
  const metaEntries = Object.entries(row)
    .filter(
      ([k, v]) =>
        k[0] !== "_" &&
        k[0] !== "@" &&
        !(v !== null && typeof v === "object"),
    )
    .map(([k, v]) => ({ k, v, flag: cellFlagClass(row[`_${k}`]) }));

  return (
    <section
      className={`channel-view${metaCollapsed ? " meta-collapsed" : ""}`}
    >
      {/* Head: channel swatch + title, live/seq status, prev/next nav. */}
      <header className="chv-vhead channel-head">
        <span
          className="sw"
          style={{ background: channelInfo?.colour ?? "var(--line-mid)" }}
        />
        <h3>
          {cameraInfo?.title ?? camera} / {channel}
        </h3>
        {live ? (
          <span className="tag live live-badge" role="status">
            LIVE
          </span>
        ) : (
          <Link
            className="live-link"
            to={`/${location}/${camera}/${channel}/current`}
          >
            Jump to current
          </Link>
        )}
        {src && !isVideo && (
          <a
            className="chv-download"
            href={src}
            download={`${camera}_${channel}_${date}_${String(seq).padStart(
              6,
              "0",
            )}.${fileExtFor(seq)}`}
            title="Download this image"
          >
            <DownloadIcon />
            <span>Download</span>
          </a>
        )}
        <span style={{ flex: 1 }} />
        <nav className="seq-nav">
          {prev !== null ? (
            <Link to={navTo(prev)}>← {prev}</Link>
          ) : (
            <span>←</span>
          )}
          <span className="seq-current">{seq}</span>
          {next !== null ? <Link to={navTo(next)}>{next} →</Link> : <span>→</span>}
        </nav>
      </header>

      <div className="media">
        {siblingChannels.length > 1 && (
          <nav
            className="chv-chan-strip"
            aria-label="Channels for this exposure"
            title="Shift + ← / → to switch channel"
          >
            {siblingChannels.map((c) => {
              const active = c.name === channel;
              const style = {
                background: c.colour ?? "var(--line-mid)",
                color: c.text_colour ?? undefined,
              };
              return active ? (
                <span
                  key={c.name}
                  className="chv-chan active"
                  style={style}
                  aria-current="page"
                >
                  {c.title}
                </span>
              ) : (
                <Link
                  key={c.name}
                  className="chv-chan"
                  style={style}
                  to={`/${location}/${camera}/${c.name}?seq=${seq}&date=${date}`}
                >
                  {c.title}
                </Link>
              );
            })}
          </nav>
        )}
        {src &&
          (isVideo ? (
            <video src={src} controls />
          ) : (
            // Wrap so the loading spinner can centre over the image itself, not
            // the whole media column (which also holds the channel strip above).
            <div className="chv-frame">
              {/* src is the latched seq, decoded before promotion (see
                  loadedSeq), so the image, seq label, and prev/next links all
                  change together. */}
              <img
                ref={imgRef}
                src={src}
                alt={`${channel} ${seq}`}
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgLoaded(true)}
                className={imgLoaded ? undefined : "chv-img-loading"}
              />
              {showSpinner && (
                <div
                  className="chv-img-spinner"
                  role="status"
                  aria-label="Loading image"
                >
                  <span className="chv-spinner" />
                </div>
              )}
            </div>
          ))}
      </div>

      <aside className="metadata-sidebar">
        {metaCollapsed ? (
          // Collapsed: a thin rail whose button reopens the panel. Reusing the
          // chevron (rotated to point left) keeps the affordance consistent.
          <button
            type="button"
            className="chv-meta-toggle collapsed"
            onClick={() => setMetaCollapsed(false)}
            aria-label="Show exposure metadata"
            aria-expanded={false}
            title="Show metadata"
          >
            <ChevronDownIcon />
          </button>
        ) : (
          <>
            <div className="chv-section-h">
              <span>Exposure metadata</span>
              <button
                type="button"
                className="chv-meta-toggle"
                onClick={() => setMetaCollapsed(true)}
                aria-label="Hide exposure metadata"
                aria-expanded={true}
                title="Hide metadata"
              >
                <ChevronDownIcon />
              </button>
            </div>
            {metaEntries.length === 0 ? (
              <p className="skeleton">No metadata for this exposure.</p>
            ) : (
              <div className="chv-meta-grid">
                {metaEntries.map(({ k, v, flag }) => (
                  <Fragment key={k}>
                    <div className="k">{k}</div>
                    <div className={flag ? `v ${flag}` : "v"}>{String(v)}</div>
                  </Fragment>
                ))}
              </div>
            )}
          </>
        )}
      </aside>
    </section>
  );
}

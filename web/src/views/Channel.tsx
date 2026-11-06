import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
import {
  ViewerIcon,
  JumpToCurrentIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
} from "../components/Icons";

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

  // Reset the latch when the date or channel changes (day_obs rollover in live
  // mode, or a channel switch). Otherwise loadedSeq would hold the previous
  // day's/channel's seq against the new date's media URL — a 404 frame and lost
  // prev/next (seqs.indexOf(seq) === -1) until the new target decodes.
  useEffect(() => {
    setLoadedSeq(null);
  }, [date, channel]);

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
  // When the displayed seq isn't in the payload (a stale bookmark, or an
  // exposure that vanished on a rescan — historical payloads are mutable),
  // idx === -1 would leave prev AND next null, dead-ending the viewer with no
  // way to step off the missing frame. Fall back to the sorted insertion point
  // so the neighbouring real exposures are still reachable.
  const insertAt =
    idx >= 0 ? idx : seqs.findIndex((s) => s > seq); // -1 if seq is past the end
  const prevIdx = idx >= 0 ? idx - 1 : insertAt === -1 ? seqs.length - 1 : insertAt - 1;
  const nextIdx = idx >= 0 ? idx + 1 : insertAt; // insertAt already points past seq
  const prev = prevIdx >= 0 && prevIdx < seqs.length ? seqs[prevIdx] : null;
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
  const hasNewer = nextIdx >= 0 && nextIdx < seqs.length;
  const catchingUp = live && seq !== targetSeq;

  usePageTitle(
    `${cameraInfo?.title ?? camera} / ${channel}`,
    live ? "LIVE" : seq ? `#${seq}` : undefined,
  );
  const next = hasNewer && !catchingUp ? seqs[nextIdx] : null;

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
  // would then never fire — mark loaded immediately in that case. Also stash
  // the element so the zoom-overflow measurement can read its natural size.
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const imgRef = (el: HTMLImageElement | null) => {
    imgElRef.current = el;
    if (el?.complete) setImgLoaded(true);
  };
  const showSpinner = !isVideo && src !== "" && !imgLoaded;

  // Click-to-zoom for the still image. Two states:
  //   * "fill" (default, enlarged): the image is width:100% of the media column
  //     and, aspect preserved, usually taller than the frame — so it scrolls
  //     up/down inside its own box (chvScrollRef).
  //   * "fit" (shrunk): the whole image is scaled down to fit the frame height,
  //     so the entire frame is visible with no scrolling.
  // Clicking toggles between them; on the way back to "fill" we restore the
  // scroll so the point the user clicked stays under the cursor (see below).
  // The choice persists across src changes (prev/next nav and live advances):
  // once you've zoomed out to take in the whole frame, a new exposure landing
  // shouldn't yank you back to fill.
  const [zoom, setZoom] = useState<"fill" | "fit">("fill");
  const chvScrollRef = useRef<HTMLDivElement | null>(null);

  // Zoom is only meaningful when the image, at full column width (the "fill"
  // state), is taller than its frame — i.e. it actually overflows and could be
  // shrunk to fit. A frame-width plot that already fits vertically has nothing
  // to zoom, so we disable the click and the zoom cursor for it. We compute the
  // fill height from the natural aspect (naturalHeight/naturalWidth × frame
  // width) rather than reading the current rendered height, so the answer is
  // the same whether we're currently in fill or fit.
  const [canZoom, setCanZoom] = useState(false);
  useEffect(() => {
    const box = chvScrollRef.current;
    const img = imgElRef.current;
    if (!box || !img) return;
    const measure = () => {
      const nW = img.naturalWidth;
      const nH = img.naturalHeight;
      if (!nW || !nH) return;
      const fillHeight = (nH / nW) * box.clientWidth;
      // 1px slack so a frame that lands a hair over doesn't flicker zoomable.
      const overflows = fillHeight > box.clientHeight + 1;
      setCanZoom(overflows);
      // If it no longer overflows (e.g. the sidebar collapsed and widened the
      // frame past the point of overflow), a lingering "fit" has nothing to fit
      // — return to the plain fill view.
      if (!overflows) setZoom("fill");
    };
    measure();
    // Re-measure as the frame resizes (window resize, sidebar collapse) and
    // once the image's natural size is known (load fires after a src swap).
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    img.addEventListener("load", measure);
    return () => {
      ro.disconnect();
      img.removeEventListener("load", measure);
    };
    // Re-run when the source changes (a differently-shaped image may now
    // over/underflow) and when imgLoaded flips (natural size becomes known).
  }, [src, imgLoaded]);

  const onImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const box = chvScrollRef.current;
    if (!box || !canZoom) return;
    if (zoom === "fill") {
      // Enlarged → shrink to fit. Nothing to restore; the fit image has no
      // scroll. (We remember nothing here; the enlarge step recomputes.)
      setZoom("fit");
      return;
    }
    // Shrunk → enlarge. Map the clicked point (its fraction down the currently
    // rendered image) onto the taller "fill" image, then scroll so that same
    // point sits back under the cursor's position within the box.
    const imgRect = e.currentTarget.getBoundingClientRect();
    const clickedFrac =
      imgRect.height > 0 ? (e.clientY - imgRect.top) / imgRect.height : 0;
    const cursorInBox = e.clientY - box.getBoundingClientRect().top;
    setZoom("fill");
    // After the layout flips to the taller image, place the clicked fraction of
    // its new height back under the cursor. Done post-paint so scrollHeight is
    // the enlarged image's.
    requestAnimationFrame(() => {
      const b = chvScrollRef.current;
      if (!b) return;
      b.scrollTop = clickedFrac * b.scrollHeight - cursorInBox;
    });
  };

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
  // step through the other channels available for this seq. We preventDefault
  // on any arrow we actually act on — Shift+Arrow is the browser's
  // extend-selection shortcut, so without this stepping channels would drag a
  // text selection across the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey) {
        if (e.key === "ArrowLeft" && prevChan !== null) {
          e.preventDefault();
          navigate(chanNavTo(prevChan));
        }
        if (e.key === "ArrowRight" && nextChan !== null) {
          e.preventDefault();
          navigate(chanNavTo(nextChan));
        }
        return;
      }
      if (e.key === "ArrowLeft" && prev !== null) {
        e.preventDefault();
        navigate(navTo(prev));
      }
      if (e.key === "ArrowRight" && next !== null) {
        e.preventDefault();
        navigate(navTo(next));
      }
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
        {live && (
          <span className="tag live live-badge" role="status">
            LIVE
          </span>
        )}
        {src && !isVideo && (
          <a
            className="chv-iconlink"
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            title="Open image in new tab"
            aria-label="Open image in new tab"
          >
            <ViewerIcon />
          </a>
        )}
        <span style={{ flex: 1 }} />
        <nav className="seq-nav">
          {prev !== null ? (
            <Link className="seq-arrow" to={navTo(prev)} aria-label={`Previous (${prev})`}>
              <ArrowLeftIcon />
              {prev}
            </Link>
          ) : (
            <span className="seq-arrow seq-arrow-off" aria-hidden="true">
              <ArrowLeftIcon />
            </span>
          )}
          <span className="seq-current">{seq}</span>
          {next !== null ? (
            <Link className="seq-arrow" to={navTo(next)} aria-label={`Next (${next})`}>
              {next}
              <ArrowRightIcon />
            </Link>
          ) : (
            <span className="seq-arrow seq-arrow-off" aria-hidden="true">
              <ArrowRightIcon />
            </span>
          )}
          {!live && (
            <Link
              className="seq-arrow seq-jump"
              to={`/${location}/${camera}/${channel}/current`}
              title="Jump to current"
              aria-label="Jump to current"
            >
              <JumpToCurrentIcon />
            </Link>
          )}
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
            // The wrapper is also the vertical scroll box for the enlarged image.
            <div
              ref={chvScrollRef}
              className={
                `chv-frame chv-zoom-${zoom}` + (canZoom ? " chv-zoomable" : "")
              }
            >
              {/* src is the latched seq, decoded before promotion (see
                  loadedSeq), so the image, seq label, and prev/next links all
                  change together. Click toggles fill/fit zoom. */}
              <img
                ref={imgRef}
                src={src}
                alt={`${channel} ${seq}`}
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgLoaded(true)}
                onClick={onImageClick}
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

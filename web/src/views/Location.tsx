import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE, cameraDataState } from "../lib/queryClient";
import { usePageTitle } from "../lib/usePageTitle";

// The camera-card thumbnail: the latest frame of the camera's primary channel
// (CameraSummary.primary_image, resolved server-side). Reuses the Channels
// grid's image-loading logic (see ChannelBrowser's ChannelCard): the image
// fades in once loaded rather than painting top-down, with a spinner overlay
// meanwhile — keyed on src so a swap re-arms it and a cached image (img.complete
// in the ref) clears without a flash. Falls back to the shared "no recent
// frame" placeholder when there's no indexed frame or the image fails to load.
function CamThumb({ src, offline }: { src: string | null; offline: boolean }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = (el: HTMLImageElement | null) => {
    if (el?.complete) setImgLoaded(true);
  };
  if (offline || !src || failed)
    return (
      <div className="chc-empty">
        {offline ? "no recent data" : "no recent frame"}
      </div>
    );
  return (
    <>
      <img
        ref={imgRef}
        className={"cam-thumb-img" + (imgLoaded ? "" : " chc-img-loading")}
        src={src}
        alt=""
        loading="lazy"
        onLoad={() => setImgLoaded(true)}
        onError={() => setFailed(true)}
      />
      {!imgLoaded && (
        <div className="chc-img-spinner" role="status" aria-label="Loading image">
          <span className="chv-spinner" />
        </div>
      )}
    </>
  );
}

const DOT_TITLE: Record<string, string> = {
  offline: "Offline — this camera is disabled in the configuration.",
  fresh: "Live — this camera has data for the current observing day.",
  stale: "Stale — no data yet for the current observing day; showing an earlier night.",
  nodata: "No data — this camera has never produced any data.",
};

// Freshness → the cam-card status label + modifier class. "nodata" (a camera
// that has never produced anything) maps to an empty class so it falls through
// to the neutral grey dot, keeping it visually distinct from the amber "stale"
// (a camera with history that's merely behind).
const STATUS_LABEL: Record<string, string> = {
  fresh: "live",
  stale: "stale",
  offline: "offline",
  nodata: "no data",
};
const STATUS_CLASS: Record<string, string> = {
  fresh: "on",
  stale: "stale",
  offline: "",
  nodata: "",
};

// Location landing: camera groups as a card grid, plus an Apps group for
// Cluster status when the location advertises one. Each card carries a
// placeholder latest-frame thumbnail and a fresh/stale/offline status; offline
// cameras aren't navigable. Ported from the RubinTV Design System location view
// (ui_kits/rubintv) — real title/freshness only, no camera photos.
export function Location() {
  const { location = "" } = useParams();
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.location(location),
    queryFn: () => api.location(location),
    staleTime: STALE.config,
  });
  usePageTitle(data?.title ?? location);

  if (isPending) return <p className="skeleton">Loading…</p>;
  if (isError || !data) return <p role="alert">Could not load location.</p>;

  return (
    <section>
      {data.camera_groups.map((group) => (
        <div key={group.label} className="cam-group">
          <div className="cam-group-h">{group.label}</div>
          <div className="cam-grid">
            {group.cameras.map((cam) => {
              const state = cameraDataState(cam.online, cam.latest_date);
              const offline = state === "offline";
              const statusLabel = STATUS_LABEL[state] ?? "—";
              const statusClass = STATUS_CLASS[state] ?? "";
              const body = (
                <>
                  <div className="cam-thumb">
                    <CamThumb
                      src={api.primaryImageUrl(cam.primary_image)}
                      offline={offline}
                    />
                  </div>
                  <div className="cam-card-body">
                    <span className="cam-card-name">{cam.title}</span>
                    <span
                      className={`cam-card-status ${statusClass}`}
                      title={DOT_TITLE[state]}
                    >
                      {statusLabel}
                    </span>
                  </div>
                </>
              );
              // Offline cameras aren't navigable (no live page yet).
              return offline ? (
                <div key={cam.name} className="cam-card off">
                  {body}
                </div>
              ) : (
                <Link
                  key={cam.name}
                  className="cam-card"
                  to={`/${location}/${cam.name}`}
                >
                  {body}
                </Link>
              );
            })}
          </div>
        </div>
      ))}

      {data.has_cluster_status && (
        <div className="cam-group">
          <div className="cam-group-h">Apps</div>
          <div className="cam-grid">
            <Link className="cam-card cam-card--plain" to="/detectors">
              <div className="cam-card-body">
                <span className="cam-card-name">Cluster status</span>
                <span className="cam-card-status on">live</span>
              </div>
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}

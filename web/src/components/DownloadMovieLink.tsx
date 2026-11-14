import { DownloadIcon } from "./Icons";

// Download button for a movie caption (All Sky tiles, the per-day channel
// viewer). Same-origin, so `download` saves it under the proxy's
// Content-Disposition name (e.g. allsky_movies_<date>_final.mp4) rather than
// navigating to it. Icon-only unless showLabel; the label is always the
// accessible name and tooltip.
export function DownloadMovieLink({
  src,
  showLabel = false,
}: {
  src: string;
  showLabel?: boolean;
}) {
  const label = "Download movie";
  return (
    <a
      className="amh-action"
      href={src}
      download
      title={label}
      aria-label={showLabel ? undefined : label}
    >
      <DownloadIcon />
      {showLabel && label}
    </a>
  );
}

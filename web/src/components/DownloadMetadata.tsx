import type { Metadata } from "../lib/types";
import { DownloadIcon } from "./Icons";

// Download the currently-loaded day's metadata as a JSON file. Operates on the
// metadata already in memory (the merged streamed + REST payload the table
// renders), so it reflects exactly what's on screen and needs no extra fetch.
// Disabled until there's something to save.
export function DownloadMetadata({
  metadata,
  filename,
  disabled = false,
}: {
  metadata: Metadata;
  filename: string;
  disabled?: boolean;
}) {
  const onClick = () => {
    const blob = new Blob([JSON.stringify(metadata, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    // Release the object URL once the click-triggered download has started.
    URL.revokeObjectURL(url);
  };

  return (
    <button
      type="button"
      className="download-metadata"
      onClick={onClick}
      disabled={disabled}
    >
      <DownloadIcon />
      Download metadata
    </button>
  );
}

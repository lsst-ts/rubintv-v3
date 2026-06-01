import { useState } from "react";

// Copy a shareable link to the current view. The URL fully describes the
// view (path = location/camera, query = date), so pasting it elsewhere
// restores the exact camera + date. We pass the resolved date explicitly so
// the link carries it even before the user has touched the date picker (the
// default date isn't written to the URL until changed).
export function ShareLink({ date }: { date?: string }) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    const url = new URL(window.location.href);
    if (date && !url.searchParams.has("date")) {
      url.searchParams.set("date", date);
    }
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure context / permissions); leave the
      // button quiet rather than throwing.
    }
  };

  return (
    <button type="button" className="share-link" onClick={onClick}>
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}

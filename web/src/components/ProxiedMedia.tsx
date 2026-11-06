import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type SyntheticEvent,
} from "react";
import { useReportInterruption } from "../lib/MediaInterruption";

// <img>/<video> for media served through the S3 proxy, which copes with a
// download that's cut short. When the proxy can't finish an object (its S3
// read broke and couldn't be resumed) it aborts the connection rather than
// end the response early, so the browser never caches a truncated file as
// whole — but an <img> then shows nothing at all. These keep what arrived on
// screen and report the interruption, so the shell can suggest a reload.

// Fetch a URL and keep whatever of its body arrives. `complete` is false when
// the transfer was cut off part-way; null when nothing usable came back (an
// HTTP error, no bytes, or the network down before the headers).
async function fetchWhatArrives(
  url: string,
  signal: AbortSignal,
): Promise<{ blob: Blob; complete: boolean } | null> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal });
  } catch {
    return null;
  }
  if (!resp.ok || !resp.body) return null;
  const reader = resp.body.getReader();
  const parts: Uint8Array[] = [];
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      parts.push(value);
    }
  } catch {
    // Cut off mid-body: keep what arrived.
  }
  if (parts.length === 0) return null;
  const type = resp.headers.get("content-type") ?? "";
  return { blob: new Blob(parts as BlobPart[], { type }), complete };
}

// An <img> that, when its load fails, fetches the same URL itself and shows
// what arrives: all of it if this attempt completes (the break was
// transient), or the part that got through — a truncated image still draws
// its top rows — in which case the interruption is reported. Only when
// nothing usable comes back (e.g. a 404) does the caller's onError run, so
// placeholders and spinners behave as they did for a plain <img>.
export function ProxiedImg({
  src,
  onError,
  ...rest
}: ComponentProps<"img"> & { src: string }) {
  const report = useReportInterruption();
  // The recovered copy (a blob: URL) and the src it stands in for, so a new
  // src starts over.
  const [recovered, setRecovered] = useState<{ src: string; url: string } | null>(
    null,
  );
  const attempt = useRef<{ src: string; ctl: AbortController } | null>(null);

  // Cancel a recovery still in flight when the src changes or on unmount.
  useEffect(
    () => () => {
      attempt.current?.ctl.abort();
      attempt.current = null;
    },
    [src],
  );
  // Free a recovered copy once it's no longer shown.
  useEffect(() => {
    if (!recovered) return;
    return () => URL.revokeObjectURL(recovered.url);
  }, [recovered]);

  const shown = recovered?.src === src ? recovered.url : src;

  const handleError = (e: SyntheticEvent<HTMLImageElement>) => {
    // Already recovering this src: let that attempt decide.
    if (shown === src && attempt.current?.src === src) return;
    // The recovered copy itself won't draw: give up as a plain <img> would.
    if (shown !== src) {
      onError?.(e);
      return;
    }
    const ctl = new AbortController();
    attempt.current = { src, ctl };
    void fetchWhatArrives(src, ctl.signal).then((got) => {
      if (ctl.signal.aborted) return;
      if (!got) {
        onError?.(e);
        return;
      }
      if (!got.complete) report();
      setRecovered({ src, url: URL.createObjectURL(got.blob) });
    });
  };

  return <img {...rest} src={shown} onError={handleError} />;
}

// Whether a failed media URL is really there: a cheap one-byte GET. A
// network failure counts as "there" — the connection, not the file, is the
// problem.
async function servedOk(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, { headers: { Range: "bytes=0-0" } });
    void resp.body?.cancel();
    return resp.ok;
  } catch {
    return true;
  }
}

// A <video> that reports a cut-off download. Chrome retries a movie whose
// transfer breaks for about half a minute, then reports what it has as an
// unsupported format (MEDIA_ERR_SRC_NOT_SUPPORTED, not a network error: the
// partial file lacks its index) — the same code a missing movie gets. So any
// error is checked against the server: a movie it still serves was
// interrupted; one it doesn't (a 404) wasn't. A movie can't be shown in part
// the way an image can, so there's nothing to recover; the frames it did
// play stay on screen.
export function ProxiedVideo({
  src,
  onError,
  ...rest
}: ComponentProps<"video"> & { src: string }) {
  const report = useReportInterruption();
  const handleError = (e: SyntheticEvent<HTMLVideoElement>) => {
    onError?.(e);
    void servedOk(src).then((there) => {
      if (there) report();
    });
  };
  return <video {...rest} src={src} onError={handleError} />;
}

// The shell's notice that a download on this page was cut short: a status
// pill beside the S3/scan pills that reloads the page. A reload fetches the
// media afresh — the proxy aborts a cut-off transfer, so the browser never
// cached the partial copy.
export function InterruptedNotice() {
  return (
    <span role="alert">
      <button
        type="button"
        className="conn interrupt-pill"
        title="A download was cut short, so an image or movie on this page may be incomplete. Reload the page to fetch it again."
        onClick={() => window.location.reload()}
      >
        Download interrupted · Reload
      </button>
    </span>
  );
}

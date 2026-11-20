import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type Ref,
  type SyntheticEvent,
} from "react";
import { useReportInterruption } from "../lib/MediaInterruption";
import { useReconnects } from "../lib/LiveContext";

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
//
// An image that isn't whole on screen is fetched again when the tab's
// connection to the server comes back: the outage that cost it is over, and
// nothing else would ask for the same URL a second time. That goes for one
// left incomplete or missing as above, and for one still loading, which over
// a connection that died without closing would hang for minutes more.
export function ProxiedImg({
  src,
  onError,
  onLoad,
  ref,
  ...rest
}: ComponentProps<"img"> & { src: string }) {
  const report = useReportInterruption();
  const reconnects = useReconnects();
  const seenReconnects = useRef(reconnects);
  const el = useRef<HTMLImageElement | null>(null);
  const setEl = (node: HTMLImageElement | null) => {
    el.current = node;
    return passRef(ref, node);
  };
  // The src the browser loaded whole by itself, and the src that is on
  // screen in part or not at all: what a reconnect goes by.
  const loaded = useRef<string | null>(null);
  const unfinished = useRef<string | null>(null);
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

  // Fetch the src and show what arrives; `nothing` runs when that's nothing.
  const recover = (nothing: () => void) => {
    const ctl = new AbortController();
    attempt.current = { src, ctl };
    void fetchWhatArrives(src, ctl.signal).then((got) => {
      if (ctl.signal.aborted) return;
      unfinished.current = got?.complete ? null : src;
      if (!got) {
        nothing();
        return;
      }
      if (!got.complete) report();
      setRecovered({ src, url: URL.createObjectURL(got.blob) });
    });
  };

  const handleError = (e: SyntheticEvent<HTMLImageElement>) => {
    // Already recovering this src: let that attempt decide.
    if (shown === src && attempt.current?.src === src) return;
    // The recovered copy itself won't draw: give up as a plain <img> would.
    if (shown !== src) {
      unfinished.current = src;
      onError?.(e);
      return;
    }
    recover(() => onError?.(e));
  };

  const handleLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    if (shown === src) {
      // The browser's own load got there: a fetch racing it has nothing to
      // add.
      loaded.current = src;
      unfinished.current = null;
      attempt.current?.ctl.abort();
      attempt.current = null;
    }
    onLoad?.(e);
  };

  // The connection is back: have another go at an image that isn't whole.
  // What's on screen stays until the new copy arrives, and if none does.
  useEffect(() => {
    if (seenReconnects.current === reconnects) return;
    seenReconnects.current = reconnects;
    const img = el.current;
    if (!img) return;
    const whole =
      shown === src
        ? loaded.current === src || (img.complete && img.naturalWidth > 0)
        : unfinished.current !== src;
    if (whole) return;
    if (rest.loading === "lazy" && shown === src && !img.complete) {
      // Still loading, or a lazy image that hasn't begun, and those can't be
      // told apart: start the browser's own request over, which leaves one
      // that is waiting to scroll into view waiting.
      img.src = src;
      return;
    }
    attempt.current?.ctl.abort();
    // If this comes to nothing, a failure of the browser's own load, should
    // it still be under way, gets its own try.
    recover(() => {
      attempt.current = null;
    });
    // Only a reconnect starts this; a new src starts over by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnects]);

  return (
    <img
      {...rest}
      ref={setEl}
      src={shown}
      onLoad={handleLoad}
      onError={handleError}
    />
  );
}

// Hand an element to a ref the caller passed, whichever kind it is.
function passRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === "function") return ref(node);
  if (ref) ref.current = node;
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
// play stay on screen. Like an image, a movie that failed, or has nothing to
// show yet for a load still under way, is loaded again when the tab's
// connection comes back.
export function ProxiedVideo({
  src,
  onError,
  ref,
  ...rest
}: ComponentProps<"video"> & { src: string }) {
  const report = useReportInterruption();
  const reconnects = useReconnects();
  const seenReconnects = useRef(reconnects);
  const el = useRef<HTMLVideoElement | null>(null);
  const setEl = (node: HTMLVideoElement | null) => {
    el.current = node;
    return passRef(ref, node);
  };
  // The src whose load failed, to try on a reconnect.
  const failed = useRef<string | null>(null);
  useEffect(() => {
    if (seenReconnects.current === reconnects) return;
    seenReconnects.current = reconnects;
    const video = el.current;
    if (!video) return;
    const stuck =
      video.readyState === HTMLMediaElement.HAVE_NOTHING &&
      video.networkState === HTMLMediaElement.NETWORK_LOADING;
    if (failed.current !== src && !stuck) return;
    failed.current = null;
    video.load();
    // Only a reconnect starts this; a new src loads by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnects]);
  const handleError = (e: SyntheticEvent<HTMLVideoElement>) => {
    failed.current = src;
    onError?.(e);
    void servedOk(src).then((there) => {
      if (there) report();
    });
  };
  return <video {...rest} ref={setEl} src={src} onError={handleError} />;
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

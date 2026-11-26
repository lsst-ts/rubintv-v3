import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { MediaInterruptionProvider } from "../lib/MediaInterruption";
import { openLiveSockets, reconnectLive } from "../test-setup";
import { InterruptedNotice, ProxiedImg, ProxiedVideo } from "./ProxiedMedia";

// A response body that delivers `bytes` and then, unless `complete`, fails
// the way a connection cut mid-transfer does.
function body(bytes: number[], complete: boolean): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (!sent) {
        sent = true;
        ctl.enqueue(new Uint8Array(bytes));
      } else if (complete) {
        ctl.close();
      } else {
        ctl.error(new TypeError("network error"));
      }
    },
  });
}

function stubFetch(resp: { ok: boolean; status?: number; body?: ReadableStream }) {
  const fetchMock = vi.fn(async () => ({
    status: resp.ok ? 200 : 404,
    headers: new Headers({ "content-type": "image/png" }),
    ...resp,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderImg(onError = vi.fn(), report = vi.fn()) {
  render(
    <MediaInterruptionProvider value={report}>
      <ProxiedImg src="/api/x.png" alt="frame" onError={onError} />
    </MediaInterruptionProvider>,
  );
  return { img: screen.getByRole("img", { name: "frame" }), onError, report };
}

test("an image cut short shows what arrived and reports it", async () => {
  // The proxy aborted the transfer, so the <img> failed: the component
  // fetches the URL itself, keeps the bytes that got through, and shows them
  // (a truncated image still draws its top rows) — and reports it.
  const fetchMock = stubFetch({ ok: true, body: body([1, 2, 3], false) });
  const { img, onError, report } = renderImg();
  fireEvent.error(img);
  await waitFor(() => expect(img.getAttribute("src")).toMatch(/^blob:/));
  expect(fetchMock).toHaveBeenCalledWith("/api/x.png", expect.anything());
  expect(report).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
});

test("a retry that completes shows the whole image without a notice", async () => {
  stubFetch({ ok: true, body: body([1, 2, 3], true) });
  const { img, onError, report } = renderImg();
  fireEvent.error(img);
  await waitFor(() => expect(img.getAttribute("src")).toMatch(/^blob:/));
  expect(report).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

test("an image the server doesn't have fails as a plain <img> would", async () => {
  // A 404 isn't an interruption: the caller's onError runs (placeholders,
  // spinners) and nothing is reported.
  stubFetch({ ok: false });
  const { img, onError, report } = renderImg();
  fireEvent.error(img);
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(img.getAttribute("src")).toBe("/api/x.png");
  expect(report).not.toHaveBeenCalled();
});

function renderVideo(report = vi.fn()) {
  const { container } = render(
    <MediaInterruptionProvider value={report}>
      <ProxiedVideo src="/api/m.mp4" controls />
    </MediaInterruptionProvider>,
  );
  return { video: container.querySelector("video") as HTMLVideoElement, report };
}

test("a movie that fails while the server still has it is reported", async () => {
  // Chrome reports a cut-off movie as an unsupported format, like a missing
  // one, so the server is asked (one byte) whether it's there.
  const fetchMock = stubFetch({ ok: true, body: body([0], true) });
  const { video, report } = renderVideo();
  fireEvent.error(video);
  await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledWith("/api/m.mp4", {
    headers: { Range: "bytes=0-0" },
  });
});

test("a movie the server doesn't have isn't reported", async () => {
  const fetchMock = stubFetch({ ok: false });
  const { video, report } = renderVideo();
  fireEvent.error(video);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  // A macrotask runs only after every pending promise callback, so the
  // probe's verdict has been acted on by then.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(report).not.toHaveBeenCalled();
});

test("an image whose retry can't connect fails as a plain <img> would", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  const { img, onError, report } = renderImg();
  fireEvent.error(img);
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(report).not.toHaveBeenCalled();
});

test("a retry that gets no bytes at all fails as a plain <img> would", async () => {
  stubFetch({ ok: true, body: new ReadableStream({ start: (c) => c.close() }) });
  const { img, onError } = renderImg();
  fireEvent.error(img);
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(img.getAttribute("src")).toBe("/api/x.png");
});

test("a second failure while recovering doesn't start another fetch", async () => {
  const fetchMock = stubFetch({ ok: true, body: body([1, 2, 3], true) });
  const { img } = renderImg();
  fireEvent.error(img);
  fireEvent.error(img);
  await waitFor(() => expect(img.getAttribute("src")).toMatch(/^blob:/));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a recovered copy that still won't draw gives up", async () => {
  // e.g. the bytes that arrived aren't a decodable image after all.
  stubFetch({ ok: true, body: body([1, 2, 3], false) });
  const { img, onError } = renderImg();
  fireEvent.error(img);
  await waitFor(() => expect(img.getAttribute("src")).toMatch(/^blob:/));
  fireEvent.error(img);
  expect(onError).toHaveBeenCalledTimes(1);
});

test("a movie whose server can't be reached counts as interrupted", async () => {
  // The connection, not the file, is the problem.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  const { video, report } = renderVideo();
  fireEvent.error(video);
  await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
});

describe("once the tab's connection is back", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  // The media inside the tab's live connection, already open.
  function renderLive(media: ReactNode, report = vi.fn()) {
    const view = render(
      <QueryClientProvider client={createQueryClient()}>
        <LiveProvider>
          <MediaInterruptionProvider value={report}>{media}</MediaInterruptionProvider>
        </LiveProvider>
      </QueryClientProvider>,
    );
    act(() => openLiveSockets());
    return { ...view, report };
  }
  const blob = (img: HTMLElement) =>
    waitFor(() => expect(img.getAttribute("src")).toMatch(/^blob:/));

  test("an image that couldn't be fetched is fetched again", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    renderLive(<ProxiedImg src="/api/x.png" alt="frame" onError={onError} />);
    const img = screen.getByRole("img", { name: "frame" });
    fireEvent.error(img);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    // Still down for this try: it stays as it was, and is tried next time.
    reconnectLive();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(img.getAttribute("src")).toBe("/api/x.png");

    stubFetch({ ok: true, body: body([1, 2, 3], true) });
    reconnectLive();
    await blob(img);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("an image cut short is fetched again, whole", async () => {
    stubFetch({ ok: true, body: body([1, 2, 3], false) });
    const { report } = renderLive(<ProxiedImg src="/api/x.png" alt="frame" />);
    const img = screen.getByRole("img", { name: "frame" });
    fireEvent.error(img);
    await blob(img);
    const partial = img.getAttribute("src");
    expect(report).toHaveBeenCalledTimes(1);

    const fetchMock = stubFetch({ ok: true, body: body([1, 2, 3, 4], true) });
    reconnectLive();
    await waitFor(() => expect(img.getAttribute("src")).not.toBe(partial));
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(report).toHaveBeenCalledTimes(1);

    // Whole now, so a later reconnect leaves it alone.
    reconnectLive();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a cut-short copy that wouldn't draw is fetched again too", async () => {
    stubFetch({ ok: true, body: body([1, 2, 3], false) });
    renderLive(<ProxiedImg src="/api/x.png" alt="frame" />);
    const img = screen.getByRole("img", { name: "frame" });
    fireEvent.error(img);
    await blob(img);
    const partial = img.getAttribute("src");
    fireEvent.error(img);

    stubFetch({ ok: true, body: body([1, 2, 3, 4], true) });
    reconnectLive();
    await waitFor(() => expect(img.getAttribute("src")).not.toBe(partial));
  });

  test("an image that loaded, or recovered whole, is left alone", async () => {
    const fetchMock = stubFetch({ ok: true, body: body([1, 2, 3], true) });
    renderLive(
      <>
        <ProxiedImg src="/api/fine.png" alt="fine" />
        <ProxiedImg src="/api/x.png" alt="frame" />
      </>,
    );
    fireEvent.load(screen.getByRole("img", { name: "fine" }));
    const img = screen.getByRole("img", { name: "frame" });
    fireEvent.error(img);
    await blob(img);
    reconnectLive();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("an image still loading is fetched, in case its request has hung", async () => {
    // A connection that died without closing fails nothing: the request just
    // never ends. In jsdom no image ever finishes loading, which is that.
    const fetchMock = stubFetch({ ok: true, body: body([1, 2, 3], true) });
    const onLoad = vi.fn();
    renderLive(<ProxiedImg src="/api/x.png" alt="frame" onLoad={onLoad} />);
    const img = screen.getByRole("img", { name: "frame" });
    expect(fetchMock).not.toHaveBeenCalled();
    reconnectLive();
    await blob(img);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("the browser's own load landing first calls the fetch off", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise(() => {});
      }),
    );
    renderLive(<ProxiedImg src="/api/x.png" alt="frame" />);
    const img = screen.getByRole("img", { name: "frame" });
    reconnectLive();
    expect(signal?.aborted).toBe(false);
    fireEvent.load(img);
    expect(signal?.aborted).toBe(true);
  });

  test("a fetch that finds nothing leaves a later failure its own try", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    renderLive(<ProxiedImg src="/api/x.png" alt="frame" onError={onError} />);
    const img = screen.getByRole("img", { name: "frame" });
    reconnectLive();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();

    // The browser's own request, still under way, now fails.
    fireEvent.error(img);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a lazy image still loading has its own request started over", () => {
    // One that hasn't scrolled into view looks the same, and must not be
    // downloaded early: the browser decides again whether to load it.
    const fetchMock = stubFetch({ ok: true, body: body([1, 2, 3], true) });
    renderLive(<ProxiedImg src="/api/x.png" alt="frame" loading="lazy" />);
    const img = screen.getByRole("img", { name: "frame" });
    const setSrc = vi.fn();
    Object.defineProperty(img, "src", { set: setSrc, configurable: true });
    reconnectLive();
    expect(setSrc).toHaveBeenCalledWith("/api/x.png");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a movie that failed, or has hung, is loaded again; others are not", async () => {
    stubFetch({ ok: true, body: body([0], true) });
    const load = vi
      .spyOn(HTMLMediaElement.prototype, "load")
      .mockImplementation(() => {});
    try {
      const { container, report } = renderLive(
        <>
          <ProxiedVideo src="/api/fine.mp4" />
          <ProxiedVideo src="/api/m.mp4" />
          <ProxiedVideo src="/api/hung.mp4" />
        </>,
      );
      const [, failed, hung] = container.querySelectorAll("video");
      fireEvent.error(failed);
      await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
      // Loading, with nothing to show for it yet.
      Object.defineProperty(hung, "networkState", {
        value: HTMLMediaElement.NETWORK_LOADING,
        configurable: true,
      });

      reconnectLive();
      expect(load.mock.contexts).toEqual([failed, hung]);
      // Loaded again, the failed one has nothing left to retry.
      Object.defineProperty(hung, "networkState", { value: 0 });
      reconnectLive();
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      load.mockRestore();
    }
  });
});

test("the interrupted-download notice reloads the page", () => {
  const real = window.location;
  const reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...real, reload },
  });
  try {
    render(<InterruptedNotice />);
    expect(screen.getByRole("alert")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Reload/ }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: real });
  }
});

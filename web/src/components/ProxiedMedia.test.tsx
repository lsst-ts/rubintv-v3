import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MediaInterruptionProvider } from "../lib/MediaInterruption";
import { ProxiedImg, ProxiedVideo } from "./ProxiedMedia";

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

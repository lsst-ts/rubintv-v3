import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { createQueryClient } from "../lib/queryClient";
import { LiveProvider } from "../lib/LiveContext";
import { ChannelBrowser } from "./ChannelBrowser";
import type { CalendarOut, CameraOut, DatePayload } from "../lib/types";

// The grid's date is the newest calendar date; channel_latest names each
// channel's most recent date so a card empty on that newest date can link to
// its last known plot instead of a live view that would render nothing.
const NEWEST = "2026-04-10";
const EARLIER = "2026-04-08";

const channel = (name: string, over: Partial<CameraOut["channels"][number]> = {}) => ({
  name,
  title: name,
  label: name,
  colour: null,
  text_colour: null,
  icon: null,
  per_day: false,
  ...over,
});

function stub(opts: {
  channels: CameraOut["channels"];
  payload: DatePayload;
  channelLatest: CalendarOut["channel_latest"];
}) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown = {};
    if (url.endsWith("/cameras/lsstcam")) {
      body = { name: "lsstcam", title: "LSSTCam", channels: opts.channels };
    } else if (url.endsWith("/calendar")) {
      body = {
        dates: [NEWEST, EARLIER],
        counts: {},
        max_seq: {},
        channel_latest: opts.channelLatest,
      } satisfies CalendarOut;
    } else if (url.includes("/dates/")) {
      body = opts.payload;
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

function renderBrowser() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <MemoryRouter initialEntries={["/local/lsstcam/channels"]}>
          <Routes>
            <Route
              path="/:location/:camera/channels"
              element={<ChannelBrowser />}
            />
          </Routes>
        </MemoryRouter>
      </LiveProvider>
    </QueryClientProvider>,
  );
}

const emptyPayload: DatePayload = {
  date: NEWEST,
  channels: {},
  extensions: {},
  per_day: {},
  has_night_report: false,
};

test("a channel with a frame today links to its live view", async () => {
  stub({
    channels: [channel("witness")],
    payload: { ...emptyPayload, channels: { witness: [1, 2] } },
    channelLatest: { witness: NEWEST },
  });
  renderBrowser();

  const link = await screen.findByRole("link", { name: /witness/ });
  expect(link.getAttribute("href")).toBe("/local/lsstcam/witness/current");
});

test("an empty channel reads its last-found date and links there", async () => {
  stub({
    channels: [channel("witness")],
    payload: emptyPayload, // no frame on the newest date
    channelLatest: { witness: EARLIER },
  });
  renderBrowser();

  // The placeholder names the last date with data, not "no recent frame".
  expect(await screen.findByText(EARLIER)).toBeDefined();
  expect(screen.getByText("last frame")).toBeDefined();
  expect(screen.queryByText("no recent frame")).toBeNull();

  // The card links to that date (bare ?date=, viewer resolves the newest seq).
  const link = screen.getByRole("link", { name: /witness/ });
  expect(link.getAttribute("href")).toBe(
    `/local/lsstcam/witness?date=${EARLIER}`,
  );
});

test("a never-seen channel keeps 'no recent frame' and the live link", async () => {
  stub({
    channels: [channel("witness")],
    payload: emptyPayload,
    channelLatest: {}, // channel has never had data
  });
  renderBrowser();

  expect(await screen.findByText("no recent frame")).toBeDefined();
  const link = screen.getByRole("link", { name: /witness/ });
  expect(link.getAttribute("href")).toBe("/local/lsstcam/witness/current");
});

test("a card image shows a loading spinner until it loads", async () => {
  stub({
    channels: [channel("witness")],
    payload: {
      ...emptyPayload,
      channels: { witness: [1, 2] },
      extensions: { witness: { default: "png", exceptions: {} } },
    },
    channelLatest: { witness: NEWEST },
  });
  renderBrowser();

  // Image not yet loaded (jsdom won't fire load): spinner shown, image hidden.
  const img = await screen.findByRole("img", { name: /witness latest/ });
  expect(screen.getByRole("status", { name: "Loading image" })).toBeDefined();
  expect(img.className).toContain("chc-img-loading");

  // On load the spinner clears and the image is revealed.
  fireEvent.load(img);
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "Loading image" })).toBeNull(),
  );
  expect(img.className).not.toContain("chc-img-loading");
});

test("an empty per-day channel shows its last date but keeps the live link", async () => {
  stub({
    channels: [channel("movies", { per_day: true })],
    payload: emptyPayload,
    channelLatest: { movies: EARLIER },
  });
  renderBrowser();

  // The seq-based viewer can't render per-day artifacts, so the link stays on
  // /current even though the placeholder still names the last date.
  expect(await screen.findByText(EARLIER)).toBeDefined();
  const link = screen.getByRole("link", { name: /movies/ });
  expect(link.getAttribute("href")).toBe("/local/lsstcam/movies/current");
});

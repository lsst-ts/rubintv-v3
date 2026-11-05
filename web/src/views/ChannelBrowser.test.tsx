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
        per_day_dates: {},
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

  // The link stays on /current even though the placeholder names the last
  // date: for a per-day channel the live viewer follows the channel's own
  // newest night, so it opens on that artifact anyway.
  expect(await screen.findByText(EARLIER)).toBeDefined();
  const link = screen.getByRole("link", { name: /movies/ });
  expect(link.getAttribute("href")).toBe("/local/lsstcam/movies/current");
});

test("a per-day channel's card shows tonight's artifact, movie or stills", async () => {
  stub({
    channels: [
      channel("movie", { per_day: true }),
      channel("plots", { per_day: true }),
      channel("legacy", { per_day: true }),
      channel("bare", { per_day: true }),
    ],
    payload: {
      ...emptyPayload,
      per_day: {
        movie: { seq: "final", ext: "mp4" },
        plots: { seq: "final", ext: "png" },
        // Entries indexed before extensions were recorded fall back to the
        // channel default, then to mp4.
        legacy: { seq: "final" },
        bare: { seq: "final" },
      } as unknown as DatePayload["per_day"],
      extensions: { legacy: { default: "jpg", exceptions: {} } },
    },
    channelLatest: {},
  });
  const { container } = renderBrowser();
  const card = async (name: string) =>
    (await screen.findByRole("link", { name: new RegExp(`^${name}`) }));

  const movie = await card("movie");
  await waitFor(() =>
    expect(movie.querySelector("video")?.getAttribute("src")).toMatch(/\.mp4$/),
  );
  expect(movie.textContent).toContain("movie");

  const plots = await card("plots");
  expect(plots.querySelector("img")?.getAttribute("src")).toMatch(/\.png$/);
  expect(plots.textContent).toContain("stills");

  expect((await card("legacy")).querySelector("img")?.getAttribute("src"))
    .toMatch(/\.jpg$/);
  expect((await card("bare")).querySelector("video")).not.toBeNull();
  expect(container.querySelectorAll(".chc-card")).toHaveLength(4);
});

test("a live channel whose latest file is a video shows a video card", async () => {
  stub({
    channels: [channel("focus")],
    payload: {
      ...emptyPayload,
      channels: { focus: [3] },
      extensions: { focus: { default: "png", exceptions: { "3": "mp4" } } },
    },
    channelLatest: {},
  });
  renderBrowser();
  const card = await screen.findByRole("link", { name: /focus/ });
  // The card renders before the night's payload; the video follows it.
  await waitFor(() =>
    expect(card.querySelector("video")?.getAttribute("src")).toContain(
      "/000003/image.mp4",
    ),
  );
  expect(card.textContent).toContain("Seq num 3");
});

test("a broken card image stops showing as loading", async () => {
  stub({
    channels: [channel("witness")],
    payload: { ...emptyPayload, channels: { witness: [1] } },
    channelLatest: {},
  });
  renderBrowser();
  const img = await screen.findByRole("img", { name: /witness latest/ });
  // No extension info: png.
  expect(img.getAttribute("src")).toContain("/000001/image.png");
  fireEvent.error(img);
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "Loading image" })).toBeNull(),
  );
});

test("a card more than five frames behind the night is flagged", async () => {
  stub({
    channels: [channel("lead"), channel("close"), channel("behind")],
    payload: {
      ...emptyPayload,
      channels: { lead: [20], close: [15], behind: [12] },
    },
    channelLatest: {},
  });
  renderBrowser();
  const behind = await screen.findByRole("link", { name: /^behind/ });
  expect(behind.className).toContain("chc-card--stale");
  const lag = behind.querySelector(".chc-lag")!;
  expect(lag.textContent).toBe("8 behind");
  expect(lag.getAttribute("title")).toBe("8 frames behind the latest channel");
  // Five behind is normal jitter, not stale.
  const close = screen.getByRole("link", { name: /^close/ });
  expect(close.className).not.toContain("chc-card--stale");
});

describe("on the live observing night", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${NEWEST}T20:00:00Z`));
  });
  afterEach(() => vi.useRealTimers());

  test("the grid says it's showing tonight", async () => {
    stub({ channels: [channel("witness")], payload: emptyPayload, channelLatest: {} });
    const { container } = renderBrowser();
    await screen.findByText("tonight");
    expect(container.querySelector(".chc-dayobs--live")?.textContent).toBe(
      `Showing tonight · ${NEWEST}`,
    );
  });
});

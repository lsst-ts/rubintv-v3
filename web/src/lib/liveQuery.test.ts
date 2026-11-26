import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { applyLiveMessage, queryKeys } from "./liveQuery";

function spyInvalidate(qc: QueryClient) {
  const calls: unknown[][] = [];
  qc.invalidateQueries = ((arg: unknown) => {
    calls.push([arg]);
    return Promise.resolve();
  }) as QueryClient["invalidateQueries"];
  return calls;
}

test("channelData invalidates date payload and calendar", () => {
  const qc = new QueryClient();
  const calls = spyInvalidate(qc);
  applyLiveMessage(qc, {
    type: "channelData",
    location: "local",
    camera: "lsstcam",
    date: "2026-04-10",
  });
  const keys = calls.map((c) =>
    JSON.stringify((c[0] as { queryKey: unknown }).queryKey),
  );
  expect(keys).toContain(
    JSON.stringify(queryKeys.datePayload("local", "lsstcam", "2026-04-10")),
  );
  // New rows for the exposure arrive as a rewrite of metadata.json, which
  // the store announces with its own `metadata` message.
  expect(keys).not.toContain(
    JSON.stringify(queryKeys.metadata("local", "lsstcam", "2026-04-10")),
  );
  // The calendar refreshes on calendarUpdate alone (the store announces a
  // new date), not on every exposure.
  expect(keys).not.toContain(
    JSON.stringify(queryKeys.calendar("local", "lsstcam")),
  );
});

test("metadata refreshes the metadata but not the date payload", () => {
  const qc = new QueryClient();
  const calls = spyInvalidate(qc);
  applyLiveMessage(qc, {
    type: "metadata",
    location: "local",
    camera: "lsstcam",
    date: "2026-04-10",
  });
  const keys = calls.map((c) =>
    JSON.stringify((c[0] as { queryKey: unknown }).queryKey),
  );
  expect(keys).toContain(
    JSON.stringify(queryKeys.metadata("local", "lsstcam", "2026-04-10")),
  );
  // The payload carries no metadata, so a rewrite can't have changed it.
  expect(keys).not.toContain(
    JSON.stringify(queryKeys.datePayload("local", "lsstcam", "2026-04-10")),
  );
});

test("an exposure's images and metadata in one poll fetch the payload once", async () => {
  // Seen on USDF dev: one poll found an exposure's images and its
  // metadata.json rewrite, and the page fetched the date payload twice. The
  // second invalidation cancelled the first fetch and started another, but
  // a cancelled fetch has already gone to the server.
  const qc = new QueryClient();
  let fetches = 0;
  const observer = new QueryObserver(qc, {
    queryKey: queryKeys.datePayload("local", "lsstcam", "2026-04-10"),
    queryFn: async () => ++fetches,
  });
  const unsubscribe = observer.subscribe(() => {});
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(1));

  const frame = { location: "local", camera: "lsstcam", date: "2026-04-10" };
  applyLiveMessage(qc, { type: "channelData", ...frame });
  applyLiveMessage(qc, { type: "metadata", ...frame });
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().fetchStatus).toBe("idle"),
  );
  expect(fetches).toBe(2);
  unsubscribe();
});

test("calendarUpdate invalidates the calendar", () => {
  const qc = new QueryClient();
  const calls = spyInvalidate(qc);
  applyLiveMessage(qc, {
    type: "calendarUpdate",
    location: "local",
    camera: "lsstcam",
    date: "2026-04-10",
  });
  const keys = calls.map((c) =>
    JSON.stringify((c[0] as { queryKey: unknown }).queryKey),
  );
  expect(keys).toContain(
    JSON.stringify(queryKeys.calendar("local", "lsstcam")),
  );
});

test("perDay invalidates the date payload and the calendar", () => {
  const qc = new QueryClient();
  const calls = spyInvalidate(qc);
  applyLiveMessage(qc, {
    type: "perDay",
    location: "local",
    camera: "auxtel",
    date: "2026-04-10",
  });
  const keys = calls.map((c) =>
    JSON.stringify((c[0] as { queryKey: unknown }).queryKey),
  );
  expect(keys).toContain(
    JSON.stringify(queryKeys.datePayload("local", "auxtel", "2026-04-10")),
  );
  // A movie usually lands on a date the calendar already has, so no
  // calendarUpdate follows — but it adds a night to per_day_dates, which the
  // per-day viewer follows.
  expect(keys).toContain(JSON.stringify(queryKeys.calendar("local", "auxtel")));
});

test("messages without location/camera are ignored", () => {
  const qc = new QueryClient();
  const calls = spyInvalidate(qc);
  applyLiveMessage(qc, { type: "channelData" });
  expect(calls).toHaveLength(0);
});

const keysOf = (calls: unknown[][]) =>
  calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));

test("nightReport refreshes that night's summary; without a date, nothing", () => {
  const qc = new QueryClient();
  const calls = spyInvalidate(qc);
  const msg = { type: "nightReport", location: "local", camera: "lsstcam" };
  applyLiveMessage(qc, msg);
  expect(calls).toEqual([]);
  applyLiveMessage(qc, { ...msg, date: "2026-04-10" });
  expect(keysOf(calls)).toEqual([
    JSON.stringify(queryKeys.nightReport("local", "lsstcam", "2026-04-10")),
  ]);
});

test("dayChange refreshes the calendar so the new night appears", () => {
  const qc = new QueryClient();
  const calls = spyInvalidate(qc);
  applyLiveMessage(qc, { type: "dayChange", location: "local", camera: "lsstcam" });
  expect(keysOf(calls)).toEqual([
    JSON.stringify(queryKeys.calendar("local", "lsstcam")),
  ]);
});

test("site-wide snapshots without a payload store an empty one", () => {
  const qc = new QueryClient();
  applyLiveMessage(qc, { type: "detectorStatus" });
  applyLiveMessage(qc, { type: "controlReadback" });
  expect(qc.getQueryData(queryKeys.detectorStatus())).toEqual({});
  expect(qc.getQueryData(queryKeys.controlReadback())).toEqual({});
  // Nor do they say anything about Redis, so nothing is recorded of it.
  expect(qc.getQueryData(queryKeys.detectorWritten())).toEqual({});
  expect(qc.getQueryData(queryKeys.redisLink())).toBeUndefined();
});

describe("how fresh the site-wide snapshots are", () => {
  const NOW = Date.UTC(2026, 10, 24, 14, 5, 0);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  test("ages are placed on the tab's clock as the message arrives", () => {
    // The server sends ages, not times, so its clock and the tab's needn't
    // agree.
    const qc = new QueryClient();
    applyLiveMessage(qc, {
      type: "detectorStatus",
      data: {
        detectors: { sfmSet0: {} },
        ages: { sfmSet0: 90, otherQueues: 0.5 },
        redis: {
          configured: true,
          connected: true,
          changed_age_seconds: 600,
          read_age_seconds: 2,
        },
      },
    });
    expect(qc.getQueryData(queryKeys.detectorWritten())).toEqual({
      sfmSet0: NOW - 90_000,
      otherQueues: NOW - 500,
    });
    expect(qc.getQueryData(queryKeys.redisLink())).toEqual({
      configured: true,
      connected: true,
      changedAt: NOW - 600_000,
      readAt: NOW - 2000,
    });
  });

  test("either message carries the link, and the later one stands", () => {
    const qc = new QueryClient();
    applyLiveMessage(qc, {
      type: "detectorStatus",
      data: {
        redis: {
          configured: true,
          connected: true,
          changed_age_seconds: 600,
          read_age_seconds: 2,
        },
      },
    });
    applyLiveMessage(qc, {
      type: "controlReadback",
      data: {
        controls: {},
        redis: {
          configured: true,
          connected: false,
          changed_age_seconds: 1,
          read_age_seconds: null,
        },
      },
    });
    const down = {
      configured: true,
      connected: false,
      changedAt: NOW - 1000,
      readAt: null,
    };
    expect(qc.getQueryData(queryKeys.redisLink())).toEqual(down);
    // One without it (an older server) leaves that alone.
    applyLiveMessage(qc, { type: "controlReadback", data: { controls: {} } });
    expect(qc.getQueryData(queryKeys.redisLink())).toEqual(down);
  });
});

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  applyLiveMessage,
  metadataEtag,
  queryKeys,
  resetMetadataStream,
} from "./liveQuery";

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
  // The REST metadata query is a separate cache entry; it must be invalidated
  // too or the single-channel view / table never pick up new seqs' rows.
  expect(keys).toContain(
    JSON.stringify(queryKeys.metadata("local", "lsstcam", "2026-04-10")),
  );
  // The calendar refreshes on calendarUpdate alone (the store announces a
  // new date), not on every exposure.
  expect(keys).not.toContain(
    JSON.stringify(queryKeys.calendar("local", "lsstcam")),
  );
});

test("metadata refreshes the REST metadata but not the date payload", () => {
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

test("metadataChunk accumulates into the stream slot and tracks rows", () => {
  const qc = new QueryClient();
  const streamKey = queryKeys.metadataStream("local", "lsstcam", "2026-04-10");
  const progKey = queryKeys.metadataProgress("local", "lsstcam", "2026-04-10");

  applyLiveMessage(qc, {
    type: "metadataChunk",
    location: "local",
    camera: "lsstcam",
    date: "2026-04-10",
    seq: 0,
    data: { "1": { exp_time: 30 } },
  });
  applyLiveMessage(qc, {
    type: "metadataChunk",
    location: "local",
    camera: "lsstcam",
    date: "2026-04-10",
    seq: 1,
    data: { "2": { exp_time: 31 } },
  });

  // Both chunks accumulate; the stream slot holds the union.
  expect(qc.getQueryData(streamKey)).toEqual({
    "1": { exp_time: 30 },
    "2": { exp_time: 31 },
  });
  // Progress is the running row and chunk count; the stream is in flight.
  expect(qc.getQueryData(progKey)).toEqual({ rows: 2, chunks: 2 });
  expect(
    qc.getQueryData(
      queryKeys.metadataStreamStatus("local", "lsstcam", "2026-04-10"),
    ),
  ).toBe("streaming");
});

test("metadataComplete with chunks missing keeps rows and flags incomplete", () => {
  const qc = new QueryClient();
  const pkey = queryKeys.metadataProgress("local", "lsstcam", "2026-04-10");
  const skey = queryKeys.metadataStream("local", "lsstcam", "2026-04-10");
  const statusKey = queryKeys.metadataStreamStatus(
    "local",
    "lsstcam",
    "2026-04-10",
  );
  // One chunk arrived of two sent: the server dropped one for a slow client.
  qc.setQueryData(pkey, { rows: 1, chunks: 1 });
  qc.setQueryData(skey, { "1": { exp_time: 30 } });
  applyLiveMessage(qc, {
    type: "metadataComplete",
    location: "local",
    camera: "lsstcam",
    date: "2026-04-10",
    total: 2,
  });
  expect(qc.getQueryData(pkey)).toBeNull();
  // Streamed rows survive (the table still renders them)...
  expect(qc.getQueryData(skey)).toEqual({ "1": { exp_time: 30 } });
  // ...and the gap is flagged, which is what enables the REST backstop.
  expect(qc.getQueryData(statusKey)).toBe("incomplete");
});

test("a complete re-stream replaces the shown rows, dropping deleted ones", () => {
  const qc = new QueryClient();
  const skey = queryKeys.metadataStream("local", "lsstcam", "2026-04-10");
  const statusKey = queryKeys.metadataStreamStatus(
    "local",
    "lsstcam",
    "2026-04-10",
  );
  // An earlier stream showed rows 1 and 2; row 2 has since been deleted
  // server-side and the file rewritten.
  qc.setQueryData(skey, { "1": { exp_time: 30 }, "2": { exp_time: 31 } });
  const msg = { location: "local", camera: "lsstcam", date: "2026-04-10" };
  applyLiveMessage(qc, {
    type: "metadataChunk",
    ...msg,
    seq: 0,
    data: { "1": { exp_time: 30 } },
  });
  // Mid-stream the old rows are still shown (no blanking while it fills).
  expect(qc.getQueryData(skey)).toEqual({
    "1": { exp_time: 30 },
    "2": { exp_time: 31 },
  });
  applyLiveMessage(qc, {
    type: "metadataChunk",
    ...msg,
    seq: 1,
    data: { "3": { exp_time: 32 } },
  });
  applyLiveMessage(qc, { type: "metadataComplete", ...msg, total: 2 });
  // Every chunk arrived: the stream is the whole document, so row 2 goes.
  expect(qc.getQueryData(skey)).toEqual({
    "1": { exp_time: 30 },
    "3": { exp_time: 32 },
  });
  expect(qc.getQueryData(statusKey)).toBe("complete");
});

test("resetMetadataStream clears the accumulation; later chunks re-accumulate", () => {
  const qc = new QueryClient();
  const skey = queryKeys.metadataStream("local", "lsstcam", "2026-04-10");
  qc.setQueryData(skey, {
    "1": { exp_time: 30 },
    // A row deleted server-side: gone from the refetched REST metadata, but
    // the stream slot alone would keep it alive as a ghost.
    "2": { exp_time: 31 },
  });

  // A fresh REST metadata document supersedes everything streamed before it.
  resetMetadataStream(qc, "local", "lsstcam", "2026-04-10");
  expect(qc.getQueryData(skey)).toEqual({});

  // Chunks arriving after the reset accumulate on top as normal.
  applyLiveMessage(qc, {
    type: "metadataChunk",
    location: "local",
    camera: "lsstcam",
    date: "2026-04-10",
    seq: 2,
    data: { "3": { exp_time: 32 } },
  });
  expect(qc.getQueryData(skey)).toEqual({ "3": { exp_time: 32 } });
});

test("a complete stream records its version; a delta brings rows forward", () => {
  const qc = new QueryClient();
  const msg = { location: "local", camera: "lsstcam", date: "2026-04-10" };
  const skey = queryKeys.metadataStream("local", "lsstcam", "2026-04-10");
  applyLiveMessage(qc, {
    type: "metadataChunk",
    ...msg,
    seq: 0,
    data: { "1": { exp_time: 30 }, "2": { exp_time: 31 } },
  });
  applyLiveMessage(qc, {
    type: "metadataComplete",
    ...msg,
    total: 1,
    etag: '"v1"',
  });
  // The version the shown rows represent, to hand back on refresh.
  expect(metadataEtag(qc, "local", "lsstcam", "2026-04-10")).toBe('"v1"');

  // The producer rewrote the file: one row added, one changed, one gone.
  applyLiveMessage(qc, {
    type: "metadataDelta",
    ...msg,
    data: {
      rows: { "2": { exp_time: 32 }, "3": { exp_time: 33 } },
      removed: ["1"],
    },
    etag: '"v2"',
  });
  expect(qc.getQueryData(skey)).toEqual({
    "2": { exp_time: 32 },
    "3": { exp_time: 33 },
  });
  expect(metadataEtag(qc, "local", "lsstcam", "2026-04-10")).toBe('"v2"');
  expect(
    qc.getQueryData(
      queryKeys.metadataStreamStatus("local", "lsstcam", "2026-04-10"),
    ),
  ).toBe("complete");
});

test("an incomplete stream records no version (nothing to diff from)", () => {
  const qc = new QueryClient();
  const msg = { location: "local", camera: "lsstcam", date: "2026-04-10" };
  applyLiveMessage(qc, {
    type: "metadataChunk",
    ...msg,
    seq: 1,
    data: { "2": {} },
  });
  applyLiveMessage(qc, {
    type: "metadataComplete",
    ...msg,
    total: 2,
    etag: '"v1"',
  });
  expect(metadataEtag(qc, "local", "lsstcam", "2026-04-10")).toBeNull();
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
});

test("a delta with no body still marks the rows current at its version", () => {
  const qc = new QueryClient();
  const at = ["local", "lsstcam", "2026-04-10"] as const;
  qc.setQueryData(queryKeys.metadataStream(...at), { "1": { a: 1 } });
  applyLiveMessage(qc, { type: "metadataDelta", location: "local", camera: "lsstcam", date: "2026-04-10" });
  expect(qc.getQueryData(queryKeys.metadataStream(...at))).toEqual({ "1": { a: 1 } });
  expect(metadataEtag(qc, ...at)).toBeNull();
});

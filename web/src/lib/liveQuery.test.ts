import { QueryClient } from "@tanstack/react-query";
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
  const keys = calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
  expect(keys).toContain(JSON.stringify(queryKeys.datePayload("local", "lsstcam", "2026-04-10")));
  // The REST metadata query is a separate cache entry; it must be invalidated
  // too or the single-channel view / table never pick up new seqs' rows.
  expect(keys).toContain(JSON.stringify(queryKeys.metadata("local", "lsstcam", "2026-04-10")));
  expect(keys).toContain(JSON.stringify(queryKeys.calendar("local", "lsstcam")));
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
  // Progress is the running row count.
  expect(qc.getQueryData(progKey)).toEqual({ rows: 2 });
});

test("metadataComplete clears progress but keeps streamed rows", () => {
  const qc = new QueryClient();
  const pkey = queryKeys.metadataProgress("local", "lsstcam", "2026-04-10");
  const skey = queryKeys.metadataStream("local", "lsstcam", "2026-04-10");
  qc.setQueryData(pkey, { rows: 2 });
  qc.setQueryData(skey, { "1": { exp_time: 30 } });
  applyLiveMessage(qc, {
    type: "metadataComplete",
    location: "local",
    camera: "lsstcam",
    date: "2026-04-10",
    total: 2,
  });
  expect(qc.getQueryData(pkey)).toBeNull();
  // Streamed rows survive completion (the table still renders them).
  expect(qc.getQueryData(skey)).toEqual({ "1": { exp_time: 30 } });
});

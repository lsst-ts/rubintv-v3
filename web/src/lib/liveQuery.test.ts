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
  expect(keys).toContain(JSON.stringify(queryKeys.calendar("local", "lsstcam")));
});

test("messages without location/camera are ignored", () => {
  const qc = new QueryClient();
  const calls = spyInvalidate(qc);
  applyLiveMessage(qc, { type: "channelData" });
  expect(calls).toHaveLength(0);
});

test("metadataChunk merges into the date payload and tracks progress", () => {
  const qc = new QueryClient();
  const key = queryKeys.datePayload("local", "lsstcam", "2026-04-10");
  // Seed a payload as the REST fetch would, with channel data but no metadata.
  qc.setQueryData(key, {
    date: "2026-04-10",
    channels: { c: [1, 2] },
    extensions: {},
    per_day: {},
    metadata: {},
    has_night_report: false,
  });

  applyLiveMessage(qc, {
    type: "metadataChunk",
    location: "local",
    camera: "lsstcam",
    date: "2026-04-10",
    seq: 0,
    total: 2,
    data: { "1": { exp_time: 30 } },
  });

  const payload = qc.getQueryData(key) as {
    metadata: Record<string, unknown>;
    channels: Record<string, number[]>;
  };
  expect(payload.metadata["1"]).toEqual({ exp_time: 30 });
  // Channel data is preserved (merge, not replace).
  expect(payload.channels).toEqual({ c: [1, 2] });

  const progress = qc.getQueryData(
    queryKeys.metadataProgress("local", "lsstcam", "2026-04-10"),
  );
  expect(progress).toEqual({ received: 1, total: 2 });
});

test("metadataComplete clears progress", () => {
  const qc = new QueryClient();
  const pkey = queryKeys.metadataProgress("local", "lsstcam", "2026-04-10");
  qc.setQueryData(pkey, { received: 1, total: 2 });
  applyLiveMessage(qc, {
    type: "metadataComplete",
    location: "local",
    camera: "lsstcam",
    date: "2026-04-10",
    total: 2,
  });
  expect(qc.getQueryData(pkey)).toBeNull();
});

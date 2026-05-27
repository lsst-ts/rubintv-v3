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

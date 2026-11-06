import { render, screen, act } from "@testing-library/react";
import {
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createQueryClient } from "./queryClient";
import { applyLiveMessage, queryKeys, type MetadataProgress } from "./liveQuery";

// Reproduces CameraTable's progress-indicator wiring in isolation. The
// pushed-only query's fetcher only reflects the cache — a queryFn returning a
// default (null/{}) would run on mount and clobber the value the WS stream
// pushes via setQueryData, which was the bug that hid the indicator. The probe
// always renders a sentinel so we can assert "shown" vs "cleared".
function ProgressProbe({ date }: { date: string }) {
  const qc = useQueryClient();
  const key = queryKeys.metadataProgress("loc", "cam", date);
  const { data } = useQuery<MetadataProgress | null>({
    queryKey: key,
    queryFn: () => qc.getQueryData<MetadataProgress | null>(key) ?? null,
    staleTime: Infinity,
  });
  return (
    <span>{data && data.rows > 0 ? `loading ${data.rows} rows` : "idle"}</span>
  );
}

function chunk(qc: ReturnType<typeof createQueryClient>, rows: number) {
  const data: Record<string, Record<string, unknown>> = {};
  for (let i = 1; i <= rows; i++) data[String(i)] = {};
  applyLiveMessage(qc, {
    type: "metadataChunk",
    location: "loc",
    camera: "cam",
    date: "2026-04-10",
    seq: 0,
    data,
  });
}

test("a streamed chunk surfaces the indicator; complete clears it", async () => {
  const qc = createQueryClient();
  render(
    <QueryClientProvider client={qc}>
      <ProgressProbe date="2026-04-10" />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("idle")).toBeDefined();

  act(() => chunk(qc, 2));
  expect(await screen.findByText("loading 2 rows")).toBeDefined();

  act(() =>
    applyLiveMessage(qc, {
      type: "metadataComplete",
      location: "loc",
      camera: "cam",
      date: "2026-04-10",
      total: 1,
    }),
  );
  expect(await screen.findByText("idle")).toBeDefined();
});

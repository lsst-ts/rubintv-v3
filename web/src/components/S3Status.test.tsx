import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createQueryClient } from "../lib/queryClient";
import { S3Status } from "./S3Status";
import type { StatusResponse } from "../lib/types";

// The client behind the last renderWith, for a test that polls again.
let qc: QueryClient;

function renderWith(
  status: Partial<StatusResponse>,
  linkToStatus = false,
  verbose = false,
) {
  const payload: StatusResponse = {
    ready: true,
    cache_enabled: true,
    warm_start: false,
    historical_loading: false,
    s3_healthy: true,
    s3_slow: false,
    s3_last_cycle_seconds: 0.8,
    cameras: [],
    ...status,
  };
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(payload),
    })) as unknown as typeof fetch;
  qc = createQueryClient();
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <S3Status linkToStatus={linkToStatus} verbose={verbose} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

test("renders nothing while S3 is healthy", async () => {
  renderWith({ s3_healthy: true });
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByText(/S3 unreachable/)).toBeNull();
});

test("verbose mode shows an explicit healthy pill (Status-page sections)", async () => {
  renderWith({ s3_healthy: true }, false, true);
  expect(await screen.findByText(/S3 connected/)).toBeDefined();
});

test("shows an alert when the last poll could not reach S3", async () => {
  renderWith({ s3_healthy: false });
  expect(await screen.findByText(/S3 unreachable/)).toBeDefined();
});

test("shows an amber warning when the last poll was slow", async () => {
  renderWith({ s3_healthy: true, s3_slow: true });
  expect(await screen.findByText(/S3 slow/)).toBeDefined();
});

test("the slow tooltip reports the last cycle's duration", async () => {
  renderWith({ s3_healthy: true, s3_slow: true, s3_last_cycle_seconds: 6.34 });
  const pill = await screen.findByText(/S3 slow/);
  expect(pill.getAttribute("title")).toMatch(/6\.3s/);
});

test("unreachable takes precedence over slow", async () => {
  renderWith({ s3_healthy: false, s3_slow: true });
  expect(await screen.findByText(/S3 unreachable/)).toBeDefined();
  expect(screen.queryByText(/S3 slow/)).toBeNull();
});

test("links the slow pill to the status page when asked", async () => {
  renderWith({ s3_healthy: true, s3_slow: true }, true);
  const link = await screen.findByRole("link");
  expect(link.getAttribute("href")).toBe("/status");
  expect(link.textContent).toMatch(/S3 slow/);
});

test("links the unreachable pill to the status page when asked", async () => {
  renderWith({ s3_healthy: false }, true);
  const link = await screen.findByRole("link");
  expect(link.getAttribute("href")).toBe("/status");
  expect(link.textContent).toMatch(/S3 unreachable/);
});

test("does not link by default (in-page use)", async () => {
  renderWith({ s3_healthy: false });
  await screen.findByText(/S3 unreachable/);
  expect(screen.queryByRole("link")).toBeNull();
});

test("a failed status poll is reported, not papered over with the last answer", async () => {
  // The query keeps its last good data when a refetch fails, so a server that
  // has gone away would otherwise go on reading as it last did: healthy.
  renderWith({ s3_healthy: true, s3_slow: true });
  await screen.findByText(/S3 slow/);

  // A 4xx is not retried, so the failure shows as soon as it is polled.
  globalThis.fetch = (() =>
    Promise.resolve({ ok: false, status: 403 })) as unknown as typeof fetch;
  await act(() => qc.refetchQueries({ queryKey: ["status"] }));
  const pill = await screen.findByRole("alert");
  expect(pill.textContent).toBe("Server unreachable");
  expect(pill.getAttribute("title")).toMatch(/status check .* failed/);
  expect(screen.queryByText(/S3 slow/)).toBeNull();
});

test("a status poll that fails from the start is reported too", async () => {
  globalThis.fetch = (() =>
    Promise.resolve({ ok: false, status: 403 })) as unknown as typeof fetch;
  render(
    <MemoryRouter>
      <QueryClientProvider client={createQueryClient()}>
        <S3Status />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  expect(await screen.findByText("Server unreachable")).toBeDefined();
});

import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../lib/queryClient";
import { S3Status } from "./S3Status";
import type { StatusResponse } from "../lib/types";

function renderWith(status: Partial<StatusResponse>) {
  const payload: StatusResponse = {
    ready: true,
    cache_enabled: true,
    warm_start: false,
    historical_loading: false,
    s3_healthy: true,
    s3_slow: false,
    cameras: [],
    ...status,
  };
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(payload),
    })) as unknown as typeof fetch;
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <S3Status />
    </QueryClientProvider>,
  );
}

test("renders nothing while S3 is healthy", async () => {
  renderWith({ s3_healthy: true });
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByText(/S3 unreachable/)).toBeNull();
});

test("shows an alert when the last poll could not reach S3", async () => {
  renderWith({ s3_healthy: false });
  expect(await screen.findByText(/S3 unreachable/)).toBeDefined();
});

test("shows an amber warning when the last poll was slow", async () => {
  renderWith({ s3_healthy: true, s3_slow: true });
  expect(await screen.findByText(/S3 slow/)).toBeDefined();
});

test("unreachable takes precedence over slow", async () => {
  renderWith({ s3_healthy: false, s3_slow: true });
  expect(await screen.findByText(/S3 unreachable/)).toBeDefined();
  expect(screen.queryByText(/S3 slow/)).toBeNull();
});

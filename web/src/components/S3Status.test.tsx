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
  location?: string,
) {
  const payload: StatusResponse = {
    ready: true,
    cache_enabled: true,
    warm_start: false,
    historical_loading: false,
    s3_healthy: true,
    s3_slow: false,
    s3_last_cycle_seconds: 0.8,
    poll_stalled: false,
    last_poll_age_seconds: 2,
    locations: [],
    redis: {
      configured: false,
      connected: false,
      changed_age_seconds: null,
      read_age_seconds: null,
    },
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
        <S3Status
          linkToStatus={linkToStatus}
          verbose={verbose}
          location={location}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

// One location's own poll, as the server reports it beside the summary.
const loc = (
  location: string,
  over: Partial<StatusResponse["locations"][number]> = {},
): StatusResponse["locations"][number] => ({
  location,
  location_title: location.toUpperCase(),
  s3_healthy: true,
  s3_slow: false,
  s3_last_cycle_seconds: 0.8,
  poll_stalled: false,
  last_poll_age_seconds: 2,
  historical_loading: false,
  ...over,
});

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

test("a poll that has stalled is said first, whatever the last cycle found", async () => {
  // The other flags are the last finished cycle's, so they still read
  // "healthy" (or "unreachable") while the cycle after it hangs.
  renderWith({ poll_stalled: true, s3_healthy: true, last_poll_age_seconds: 300 });
  const pill = await screen.findByText("Poll stalled");
  expect(pill.getAttribute("role")).toBe("alert");
  expect(pill.getAttribute("title")).toMatch(/last finished one at \d\d:\d\d:\d\d UTC/);
  expect(screen.queryByText(/S3/)).toBeNull();
});

test("a poll stalled on its first cycle has no last time to give", async () => {
  renderWith({ poll_stalled: true, s3_healthy: false, last_poll_age_seconds: null });
  const pill = await screen.findByText("Poll stalled");
  expect(pill.getAttribute("title")).toMatch(/not finished one since the server started/);
  expect(screen.queryByText(/S3 unreachable/)).toBeNull();
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

// The server polls each location on its own: one bucket it can't reach is
// that location's trouble, and the summary's, and no other location's.
const ONE_DOWN: Partial<StatusResponse> = {
  s3_healthy: false,
  locations: [loc("summit"), loc("base", { s3_healthy: false })],
};

test("a location's pill is quiet while another location's bucket is down", async () => {
  renderWith(ONE_DOWN, false, true, "summit");
  const pill = await screen.findByText("S3 connected");
  expect(pill.getAttribute("title")).toMatch(/this location's S3 bucket/);
  expect(screen.queryByText(/S3 unreachable/)).toBeNull();
});

test("a location's pill reports its own bucket", async () => {
  renderWith(ONE_DOWN, false, false, "base");
  const pill = await screen.findByText("S3 unreachable");
  expect(pill.getAttribute("title")).toMatch(/could not reach this location's S3 bucket/);
});

test("with no location in view, the pill says how many it means and names them", async () => {
  // One bucket out of two mustn't read as S3 being out.
  renderWith(ONE_DOWN);
  const pill = await screen.findByText("S3: 1 of 2 unreachable");
  expect(pill.getAttribute("role")).toBe("alert");
  expect(pill.getAttribute("title")).toMatch(/the S3 bucket for BASE on its last poll/);
});

test("the plain label is kept for when every location is in the state", async () => {
  renderWith({
    s3_healthy: false,
    locations: [loc("summit", { s3_healthy: false }), loc("base", { s3_healthy: false })],
  });
  const pill = await screen.findByText("S3 unreachable");
  expect(pill.getAttribute("title")).toMatch(/the S3 bucket for SUMMIT, BASE/);
});

test("slow and stalled polls are counted the same way", async () => {
  const three = (over: Partial<StatusResponse["locations"][number]>) => [
    loc("summit", over),
    loc("base"),
    loc("tucson"),
  ];
  const slow = renderWith({ s3_slow: true, locations: three({ s3_slow: true }) });
  expect(await screen.findByText("S3: 1 of 3 slow")).toBeDefined();
  slow.unmount();
  renderWith({ poll_stalled: true, locations: three({ poll_stalled: true }) });
  expect(await screen.findByText("Poll: 1 of 3 stalled")).toBeDefined();
});

test("every location healthy reads as connected", async () => {
  renderWith({ locations: [loc("summit"), loc("base")] }, false, true);
  const pill = await screen.findByText("S3 connected");
  expect(pill.getAttribute("title")).toMatch(/every location's S3 bucket/);
});

test("a location's slow and stalled polls are its own too", async () => {
  const status: Partial<StatusResponse> = {
    s3_slow: true,
    poll_stalled: true,
    locations: [
      loc("summit", { s3_slow: true, s3_last_cycle_seconds: 7.25 }),
      loc("base", { poll_stalled: true, last_poll_age_seconds: null }),
    ],
  };
  const summit = renderWith(status, false, false, "summit");
  expect((await screen.findByText("S3 slow")).getAttribute("title")).toMatch(/7\.3s/);
  summit.unmount();
  renderWith(status, false, false, "base");
  expect((await screen.findByText("Poll stalled")).getAttribute("title")).toMatch(
    /this location's S3 bucket has stopped.*not finished one since the server started/,
  );
});

test("a server that reports no locations is read by its summary", async () => {
  // A tab left open across a deploy can be asking a server older than it.
  renderWith({ s3_healthy: false, locations: undefined }, false, false, "base");
  const pill = await screen.findByText("S3 unreachable");
  expect(pill.getAttribute("title")).toMatch(/this location's S3 bucket/);
});

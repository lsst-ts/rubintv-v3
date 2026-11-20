import { act, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../lib/queryClient";
import { DISCONNECT_GRACE_MS, LiveProvider } from "../lib/LiveContext";
import { STALE_AFTER_MS } from "../lib/lastPoll";
import { liveSockets, loseLiveConnection, openLiveSockets } from "../test-setup";
import { DataAsOf } from "./DataAsOf";

// 2026-11-20T15:00:00Z, so a poll 2 s old was at 14:59:58.
const NOW = Date.UTC(2026, 10, 20, 15, 0, 0);

// What the status endpoint answers next: an age, null before the server's
// first cycle, or "down" for a request that fails.
let answer: number | null | "down";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  answer = 2;
  globalThis.fetch = (() =>
    answer === "down"
      ? Promise.reject(new Error("unreachable"))
      : Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ last_poll_age_seconds: answer }),
        })) as unknown as typeof fetch;
});
afterEach(() => vi.useRealTimers());

function renderLabel() {
  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      <LiveProvider>
        <DataAsOf />
      </LiveProvider>
    </QueryClientProvider>,
  );
  act(() => openLiveSockets());
  return view;
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

test("says when the server last polled, quietly while that is recent", async () => {
  renderLabel();
  const label = await screen.findByText("as of 14:59:58 UTC");
  expect(label.className).toBe("data-as-of");
  expect(label.getAttribute("title")).toMatch(/last checked the bucket/);
});

test("says nothing before the server's first poll", async () => {
  answer = null;
  const { container } = renderLabel();
  await advance(1000);
  expect(container.textContent).toBe("");
});

test("a poll that stops being reported ages on the tab's clock", async () => {
  // The server goes away: its last answer is kept, and nothing arrives to
  // say it is old. The label works that out itself.
  renderLabel();
  await screen.findByText("as of 14:59:58 UTC");
  answer = "down";
  await advance(STALE_AFTER_MS);
  const label = screen.getByText(/^as of 14:59:58 UTC · \d+ s ago$/);
  expect(label.className).toContain("is-stale");
  expect(label.getAttribute("title")).toMatch(/Nothing newer than 14:59:58 UTC/);
});

test("the time follows the server's polls", async () => {
  renderLabel();
  await screen.findByText("as of 14:59:58 UTC");
  await advance(5000);
  expect(screen.getByText("as of 15:00:03 UTC").className).toBe("data-as-of");
});

test("a disconnected tab keeps the last time it had, though the server polls on", async () => {
  renderLabel();
  await screen.findByText("as of 14:59:58 UTC");
  loseLiveConnection(DISCONNECT_GRACE_MS);
  await advance(STALE_AFTER_MS);
  // The status polls kept succeeding; the page's data is no newer for it.
  const label = screen.getByText(/^as of \d\d:\d\d:\d\d UTC · \d+ s ago$/);
  expect(label.className).toContain("is-stale");
  const frozen = label.textContent!.slice(0, 18);
  await advance(10_000);
  expect(screen.getByText(/^as of/).textContent).toContain(frozen);

  // Back in touch, it catches up.
  act(() => liveSockets().at(-1)!.onopen?.());
  await advance(5000);
  expect(screen.getByText(/^as of/).className).toBe("data-as-of");
});

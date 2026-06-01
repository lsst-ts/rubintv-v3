import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../lib/queryClient";
import { LoadingBanner } from "./LoadingBanner";

function renderWith(status: { historical_loading: boolean }) {
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(status),
    })) as unknown as typeof fetch;
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LoadingBanner />
    </QueryClientProvider>,
  );
}

test("shows the banner while history is loading", async () => {
  renderWith({ historical_loading: true });
  expect(await screen.findByText(/Loading historical data/)).toBeDefined();
});

test("renders nothing once history has loaded", async () => {
  renderWith({ historical_loading: false });
  // Give the query a tick to resolve; the banner must stay absent.
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByText(/Loading historical data/)).toBeNull();
});

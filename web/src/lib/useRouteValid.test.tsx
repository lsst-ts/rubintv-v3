import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createQueryClient } from "./queryClient";
import { useRouteValid } from "./useRouteValid";

// The route guard's verdict for the less common replies. The everyday cases
// (an unknown location, camera or channel 404s; a failed locations fetch
// doesn't) run through the router in routes.test.

function stub(replies: { locations: unknown; camera: unknown | number }) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const reply = url.endsWith("/api/locations") ? replies.locations : replies.camera;
    if (typeof reply === "number") {
      return Promise.resolve({ ok: false, status: reply, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(reply) });
  }) as unknown as typeof fetch;
}

function verdictAt(path: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/:location/:camera?/:channel?" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return renderHook(() => useRouteValid(), { wrapper }).result;
}

const LOCS = [{ name: "summit", title: "Summit" }];

test("a location list that isn't a list names no locations", async () => {
  stub({ locations: { detail: "unexpected" }, camera: {} });
  const result = verdictAt("/summit");
  await waitFor(() => expect(result.current).toBe("missing"));
});

test("a camera that fails for another reason than 404 isn't called missing", async () => {
  // e.g. the admin gate (403): a transient or access problem, not a bad URL.
  stub({ locations: LOCS, camera: 403 });
  const result = verdictAt("/summit/lsstcam");
  expect(result.current).toBe("pending");
  await waitFor(() => expect(result.current).toBe("valid"));
});

test("a camera that 404s is missing", async () => {
  stub({ locations: LOCS, camera: 404 });
  const result = verdictAt("/summit/nosuch");
  await waitFor(() => expect(result.current).toBe("missing"));
});

test("a channel on a camera whose config lists none is missing", async () => {
  stub({ locations: LOCS, camera: { name: "lsstcam", title: "LSSTCam" } });
  const result = verdictAt("/summit/lsstcam/monitor");
  await waitFor(() => expect(result.current).toBe("missing"));
});

test("a camera route with no channel is valid once the camera loads", async () => {
  stub({ locations: LOCS, camera: { name: "lsstcam", channels: [] } });
  const result = verdictAt("/summit/lsstcam");
  await waitFor(() => expect(result.current).toBe("valid"));
});

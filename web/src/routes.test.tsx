import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { createQueryClient } from "./lib/queryClient";
import { routes } from "./routes";

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("a deep link resolves to the right view with its params", async () => {
  renderAt("/local/lsstcam/witness_detector");
  // The channel placeholder renders and shows the route params, proving the
  // URL fully describes the view (Decision 7).
  expect(await screen.findByText("Channel")).toBeDefined();
  expect(screen.getByText("witness_detector")).toBeDefined();
});

test("suffix route (mosaic) wins over the channel catch-all", async () => {
  renderAt("/local/lsstcam/mosaic");
  expect(await screen.findByText("Mosaic")).toBeDefined();
});

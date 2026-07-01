import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { createQueryClient } from "./lib/queryClient";
import { LiveProvider } from "./lib/LiveContext";
import { routes } from "./routes";
import "./index.css";

const queryClient = createQueryClient();
// The app is served under a path prefix (Vite `base`, e.g. /rubintv/), so the
// router lives under the same basename — deep links and generated <Link> URLs
// all carry the prefix. import.meta.env.BASE_URL is that base, trailing slash
// included, which react-router accepts.
const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>
  </StrictMode>,
);

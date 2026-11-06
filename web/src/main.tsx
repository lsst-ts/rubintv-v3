import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { createQueryClient } from "./lib/queryClient";
import { LiveProvider } from "./lib/LiveContext";
import { BASE } from "./lib/basePath";
import { routes } from "./routes";
import "./index.css";

const queryClient = createQueryClient();
// The app is served under a path prefix (Vite `base`, e.g. /rubintv/), so the
// router lives under the same basename — deep links and generated <Link> URLs
// all carry the prefix.
//
// The basename must NOT keep the base's trailing slash: react-router compares
// the URL against it literally, so a basename of "/rubintv/" fails to match a
// visit to the bare "/rubintv" and the router renders nothing at all — the
// root page appeared blank unless you typed the trailing slash. BASE is
// import.meta.env.BASE_URL with that slash stripped, and matches both spellings.
const router = createBrowserRouter(routes, { basename: BASE });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>
  </StrictMode>,
);

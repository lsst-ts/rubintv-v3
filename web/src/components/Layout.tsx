import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useParams } from "react-router-dom";
import { ConnectionStatus } from "./ConnectionStatus";
import { LoadingBanner } from "./LoadingBanner";
import { ThemeToggle } from "./ThemeToggle";
import { STALE } from "../lib/queryClient";

// Mounted sub-apps (DDV, exp_checker) are reported by the backend; render
// links to whatever is available. Sub-apps live outside the SPA router, so
// these are plain anchors.
function useSubapps(): string[] {
  const { data } = useQuery({
    queryKey: ["subapps"],
    queryFn: async () => {
      const resp = await fetch("/api/subapps");
      return (await resp.json()) as { mounted: string[] };
    },
    staleTime: STALE.config,
  });
  return data?.mounted ?? [];
}

// App shell: header with breadcrumbs + connection status, then the routed
// view. Path-based routing means breadcrumbs derive from the URL params, so
// every tab renders its own breadcrumb trail from its own URL (Decision 7).
export function Layout() {
  const { location, camera } = useParams();
  const subapps = useSubapps();

  return (
    <div className="app">
      <header className="app-header">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link to="/">RubinTV</Link>
          {location && <Link to={`/${location}`}>{location}</Link>}
          {location && camera && (
            <Link to={`/${location}/${camera}`}>{camera}</Link>
          )}
        </nav>
        <nav className="subapp-nav" aria-label="Sub-apps">
          {subapps.map((path) => (
            <a key={path} href={path}>
              {path.replace("/", "")}
            </a>
          ))}
          <Link to="/status">status</Link>
          <Link to="/admin">admin</Link>
          <ThemeToggle />
          <ConnectionStatus />
        </nav>
      </header>
      <LoadingBanner location={location} camera={camera} />
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useParams } from "react-router-dom";
import { ConnectionStatus } from "./ConnectionStatus";
import { S3Status } from "./S3Status";
import { LoadingBanner } from "./LoadingBanner";
import { ThemeToggle } from "./ThemeToggle";
import { Sidebar } from "./Sidebar";
import { STALE } from "../lib/queryClient";
import { useShellNav, tabsForCamera } from "../lib/useShellNav";

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

const SIDEBAR_KEY = "rubintv.sidebarOpen";

// App shell: collapsible sidebar (camera/system/location nav) + a main column
// whose topbar shows breadcrumbs, the camera title, and the per-camera view
// tabs. Ported from the design's two-column shell (design/from-claude/Camera
// Table - Sidebar v2.html), wired to react-router instead of the prototype's
// local page state. Breadcrumbs derive from the URL params (Decision 7).
export function Layout() {
  const { location, camera } = useParams();
  const nav = useShellNav();
  const subapps = useSubapps();

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen));
    } catch {
      // Persist is best-effort.
    }
  }, [sidebarOpen]);

  // The per-camera view tabs (Table / Channels / Night report …) from the real
  // camera config. Only shown on a camera route.
  const tabs = tabsForCamera(nav.cameraInfo);
  const onCamera = !!location && !!camera && !nav.system;

  return (
    <div className={`shell ${sidebarOpen ? "" : "collapsed"}`}>
      {sidebarOpen ? (
        <Sidebar nav={nav} onClose={() => setSidebarOpen(false)} />
      ) : (
        <div />
      )}

      <div className="main">
        <header className="topbar">
          {!sidebarOpen && (
            <div className="topbar-leftgutter">
              <button
                className="sidebar-reopen"
                onClick={() => setSidebarOpen(true)}
                title="Show sidebar"
                aria-label="Show sidebar"
              >
                »
              </button>
              <ThemeToggle vertical />
            </div>
          )}

          <nav className="crumb breadcrumbs" aria-label="Breadcrumb">
            <Link to="/">RubinTV</Link>
            {location && <Link to={`/${location}`}>{location}</Link>}
            {location && camera && (
              <Link to={`/${location}/${camera}`}>{camera}</Link>
            )}
          </nav>

          <div className="title-row">
            {onCamera ? (
              <h2>{nav.cameraInfo?.title ?? camera}</h2>
            ) : (
              <span style={{ flex: 1 }} />
            )}
            <span style={{ flex: 1 }} />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                gap: 4,
              }}
            >
              {!sidebarOpen && (
                <div className="topbar-brand">
                  <span className="brand">RubinTV</span>
                  {location && <span className="site">{location}</span>}
                </div>
              )}
              {/* Historical-scan notice: a compact inline pill above the live
                  indicator, not a full-width banner. */}
              <LoadingBanner location={location} camera={camera} />
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <nav className="subapp-nav" aria-label="Sub-apps">
                  {subapps.map((path) => (
                    <a key={path} href={path}>
                      {path.replace("/", "")}
                    </a>
                  ))}
                </nav>
                <S3Status />
                <ConnectionStatus />
              </div>
            </div>
          </div>

          {onCamera && (
            <div className="tabs">
              {tabs.map((tab) => {
                const to =
                  `/${location}/${camera}` +
                  (tab.suffix ? `/${tab.suffix}` : "");
                const active = nav.activeTab === tab.id;
                return (
                  <Link
                    key={tab.id}
                    to={to}
                    className={"tab" + (active ? " active" : "")}
                    aria-current={active ? "page" : undefined}
                  >
                    {tab.label}
                    {tab.count != null && (
                      <span className="count">{tab.count}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </header>

        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

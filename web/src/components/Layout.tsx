import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ConnectionStatus } from "./ConnectionStatus";
import { S3Status } from "./S3Status";
import { LoadingBanner } from "./LoadingBanner";
import { Sidebar } from "./Sidebar";
import { RubinMark } from "./RubinMark";
import { DatePicker } from "./DatePicker";
import { STALE } from "../lib/queryClient";
import { BASE } from "../lib/basePath";
import { useShellNav, tabsForCamera } from "../lib/useShellNav";

// Mounted sub-apps (DDV, exp_checker) are reported by the backend; render
// links to whatever is available. Sub-apps live outside the SPA router, so
// these are plain anchors.
function useSubapps(): string[] {
  const { data } = useQuery({
    queryKey: ["subapps"],
    queryFn: async () => {
      const resp = await fetch(`${BASE}/api/subapps`);
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
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
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
  // A camera can have no tabs (live-view cameras with no night report), in
  // which case the topbar is laid out like the non-camera pages — no tabs row,
  // so the status pills get the bottom padding they'd otherwise lack.
  const hasTabs = onCamera && tabs.length > 0;

  // The date picker is hoisted from the Table view into the shell so the
  // selected date persists across the Table / Channels / single-channel tabs —
  // previously switching tabs (or opening a plot) dropped the ?date= and the
  // Table reverted to the newest day. It shows on any per-date camera view once
  // a date resolves; live-view cameras (which have no per-date table) never do.
  const showDatePicker =
    onCamera && !nav.cameraInfo?.live_view && nav.date !== "";

  // Applying a date. On the Table view we just update ?date= in place. From a
  // Channels/single-channel view — where a historical date has no meaning (the
  // grid always shows the newest frame per channel) — picking a date takes the
  // user to that date's Table, which is where the date applies.
  const applyDate = (d: string) => {
    if (nav.activeTab === "table") {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set("date", d);
          return p;
        },
        { replace: true },
      );
    } else {
      navigate(`/${location}/${camera}?date=${d}`);
    }
  };

  // Headerless embedding (?headerless=true): render only the view, with no app
  // shell — no sidebar, topbar, breadcrumbs or tabs. This lets any view (the
  // live Mosaic in particular) be dropped into an <iframe> as a bare tile.
  // It's a global param, matching the original app, so it applies to whatever
  // route is mounted. The nav hooks above still run, so their data stays warm.
  if (params.get("headerless") === "true") {
    return (
      <div className="shell headerless">
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className={`shell ${sidebarOpen ? "" : "collapsed"}`}>
      {sidebarOpen ? (
        <Sidebar nav={nav} onClose={() => setSidebarOpen(false)} />
      ) : (
        <div />
      )}

      <div className="main">
        {/* Without the tabs row the status pills would sit flush on the
            topbar's bottom border; pad the bottom in that case. */}
        <header className={"topbar" + (hasTabs ? "" : " no-tabs")}>
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
            </div>
          )}

          <nav className="crumb breadcrumbs" aria-label="Breadcrumb">
            {location ? (
              <Link to="/">RubinTV</Link>
            ) : (
              <span className="here" aria-current="page">
                RubinTV
              </span>
            )}
            {location && (
              <>
                <span className="sep" aria-hidden="true">
                  ›
                </span>
                {camera ? (
                  <Link to={`/${location}`}>{location}</Link>
                ) : (
                  <span className="here">{location}</span>
                )}
              </>
            )}
            {location && camera && (
              <>
                <span className="sep" aria-hidden="true">
                  ›
                </span>
                <span className="here" aria-current="page">
                  {camera}
                </span>
              </>
            )}
          </nav>

          <div className="title-row">
            {onCamera ? (
              <h2>{nav.cameraInfo?.title ?? camera}</h2>
            ) : (
              <span style={{ flex: 1 }} />
            )}
            <span style={{ flex: 1 }} />
            <div className="topbar-right">
              {/* Vectorised Rubin mark on the right of the header. Inline SVG
                  so it inherits the constellation-cyan accent via currentColor. */}
              <RubinMark className="topbar-logo" />
              {!sidebarOpen && (
                <div className="topbar-brand">
                  <span className="brand">RubinTV</span>
                  {location && <span className="site">{location}</span>}
                </div>
              )}
              <div className="topbar-status">
                <nav className="subapp-nav" aria-label="Sub-apps">
                  {subapps.map((path) => (
                    <a key={path} href={path}>
                      {path.replace("/", "")}
                    </a>
                  ))}
                </nav>
                <S3Status />
                {/* Historical-scan notice sits with the other status signals
                    as a compact inline pill, not a full-width banner. */}
                <LoadingBanner location={location} camera={camera} />
                <ConnectionStatus />
              </div>
            </div>
          </div>

          {hasTabs && (
            <div className="tabs">
              {showDatePicker && (
                <span className="topbar-datepicker date-stepper">
                  <button
                    type="button"
                    className="tb-btn step"
                    aria-label="Previous day with data"
                    title="Previous day with data"
                    disabled={!nav.olderDate}
                    onClick={() => nav.olderDate && applyDate(nav.olderDate)}
                  >
                    ‹
                  </button>
                  <DatePicker
                    dates={nav.pickerDates}
                    counts={nav.calendar?.counts ?? {}}
                    maxSeq={nav.calendar?.max_seq ?? {}}
                    value={nav.date}
                    isCurrentDayObs={nav.isCurrentDayObs}
                    onChange={applyDate}
                  />
                  <button
                    type="button"
                    className="tb-btn step"
                    aria-label="Next day with data"
                    title="Next day with data"
                    disabled={!nav.newerDate}
                    onClick={() => nav.newerDate && applyDate(nav.newerDate)}
                  >
                    ›
                  </button>
                </span>
              )}
              {tabs.map((tab) => {
                const base =
                  `/${location}/${camera}` +
                  (tab.suffix ? `/${tab.suffix}` : "");
                // Carry the resolved date into every tab link so switching
                // views keeps the day in view — the fix for returning to the
                // Table and seeing the newest day instead of the one you left.
                // The night-report link already takes ?date= too.
                const to = nav.date ? `${base}?date=${nav.date}` : base;
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

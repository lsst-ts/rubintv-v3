import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { S3Status } from "./S3Status";
import { LoadingBanner } from "./LoadingBanner";
import { NavMenu } from "./NavMenu";
import { DatePicker } from "./DatePicker";
import { STALE } from "../lib/queryClient";
import { api } from "../lib/api";
import { instanceEnv, processingBanner } from "../lib/links";
import { useShellNav, tabsForCamera } from "../lib/useShellNav";
import { setCameraTabPref } from "../lib/cameraTabPref";

// The deployment site (RAPID_ANALYSIS_LOCATION) from /api/config, used to label the
// header. Undefined until it resolves — the env strip falls back to the
// hostname heuristic meanwhile, so a non-prod host still flags immediately.
function useSite(): string | undefined {
  const { data } = useQuery({
    queryKey: ["config"],
    queryFn: api.config,
    staleTime: STALE.config,
  });
  return data?.site;
}

// App shell: a single full-width main column whose topbar carries the
// wayfinding (breadcrumb + NavMenu drawer), the page title + per-camera view
// tabs, and the date stepper. The old collapsible sidebar has been retired in
// favour of the NavMenu drawer (RubinTV Design System, ui_kits/rubintv), so the
// brand lockup now appears only on the Home hero. Breadcrumbs derive from the
// URL params (Decision 7).
export function Layout() {
  const { location, camera } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const nav = useShellNav();
  const site = useSite();

  // The per-camera view tabs (Table / Channels / Night report …) from the real
  // camera config. Only shown on a camera route.
  const tabs = tabsForCamera(nav.cameraInfo);
  const onCamera = !!location && !!camera && !nav.system;

  // The LSSTCam processing-mode banner ("USDF Nightly Validation Processing" /
  // "Summit Quicklook Processing"). Non-null only on the lsstcam/lsstcam_aos
  // cameras of the USDF/summit locations; it labels what the pipeline behind
  // this view is doing.
  const banner = onCamera ? processingBanner(location, camera) : null;

  // A full-width strip warning that this isn't production. It shows if EITHER
  // the backend site is a non-prod shape (local/gha/test) OR the hostname looks
  // like localhost/-dev — so a prod-shaped instance served from a dev host is
  // still flagged. Shown on every full-shell route, but not on headerless
  // embeds (bare chromeless tiles).
  const env = instanceEnv(site);
  const ENV_LABELS: Record<string, string> = {
    localhost: "Localhost — development server",
    dev: "Development instance",
    ci: "CI — GitHub Actions",
    test: "Test instance",
  };
  const envLabel = ENV_LABELS[env] ?? null;
  const ENV_TAGS: Record<string, string> = {
    localhost: "LOCAL",
    dev: "DEV",
    ci: "CI",
    test: "TEST",
  };
  const envTag = ENV_TAGS[env] ?? "";
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
  //
  // Picking a date (via the picker or the prev/next-day steppers, which both
  // call this) is an inherently Table action, so remember Table as the wanted
  // tab: the next camera the user opens then lands on its Table too, matching
  // where this date actually applies.
  const applyDate = (d: string) => {
    setCameraTabPref("table");
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
  // shell — no topbar, breadcrumbs or tabs. This lets any view (the live Mosaic
  // in particular) be dropped into an <iframe> as a bare tile. It's a global
  // param, matching the original app, so it applies to whatever route is
  // mounted. The nav hooks above still run, so their data stays warm.
  if (params.get("headerless") === "true") {
    return (
      <div className="shell headerless">
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    );
  }

  // The Home (index) route is the full-bleed launcher — the one place that
  // carries the brand — and it draws its own floating NavMenu. So it renders
  // WITHOUT the wayfinding topbar (which would otherwise duplicate the "home"
  // breadcrumb and the drawer). Every inner page (a location, a camera, or a
  // system page) gets the topbar. Home is the only route with neither a
  // :location param nor a system path.
  const isHome = !location && !nav.system;
  if (isHome) {
    return (
      <div className="app-root">
        {envLabel && (
          <div className={`env-strip env-${env}`} role="status">
            <span className="env-tag">{envTag}</span>
            <span className="env-label">{envLabel}</span>
          </div>
        )}
        <div className="main main--full">
          <Outlet />
        </div>
      </div>
    );
  }

  // The topbar's big page title. Camera pages show the camera title; a bare
  // location page shows the location's display title (e.g. "USDF"). System
  // pages (status/detectors/admin) render their own <h1> in the view body, so
  // they get no topbar title here to avoid double-titling.
  const onLocation = !!location && !camera && !nav.system;
  const locationTitle =
    nav.locations.find((l) => l.name === location)?.title ?? location;
  const title = onCamera
    ? (nav.cameraInfo?.title ?? camera)
    : onLocation
      ? locationTitle
      : null;

  return (
    <div className="app-root">
      <div className="main main--full">
        {/* Without the tabs row the status pills would sit flush on the
            topbar's bottom border; pad the bottom in that case. */}
        <header className={"topbar" + (hasTabs ? "" : " no-tabs")}>
          {/* Utility strip: breadcrumb (rooted at a "home" link, never the brand, so
              "RubinTV" isn't repeated across the app — the big page title
              carries the leaf) on the left; the non-prod env warning centred; and
              scan/S3 status + the NavMenu drawer on the right. */}
          <div className="topbar-strip">
            <nav className="crumb breadcrumbs" aria-label="Breadcrumb">
              {/* "home" is never the current page here — Home has its own
                  full-bleed chrome and isn't wrapped in this topbar — so it's
                  always a link back to the launcher, on every inner page
                  (locations, cameras, and the system pages). */}
              <Link to="/">home</Link>
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
              {/* System pages (status/detectors/admin) have no :location, so
                  the system name is the crumb leaf. */}
              {nav.system && (
                <>
                  <span className="sep" aria-hidden="true">
                    ›
                  </span>
                  <span className="here" aria-current="page">
                    {nav.system}
                  </span>
                </>
              )}
            </nav>

            {/* Non-prod warning, centred in the strip. Absolutely centred so
                it stays put regardless of how wide the breadcrumb or the
                status/menu cluster grow. Keeps the env colour as a pill so the
                "this isn't production" signal survives the move off the old
                full-width bar. */}
            {envLabel && (
              <div className={`env-pill env-${env}`} role="status">
                <span className="env-tag">{envTag}</span>
                <span className="env-label">{envLabel}</span>
              </div>
            )}

            <div className="topbar-strip-right">
              <div className="topbar-status">
                {/* S3 connectivity is only meaningful (and only actionable)
                    while viewing a camera's images, so — like the historical
                    refresh pill — it's scoped to camera pages. The WebSocket
                    'connected' indicator now lives on the Status page. */}
                {onCamera && <S3Status linkToStatus />}
                {/* Historical-scan notice sits with the other status signals
                    as a compact inline pill, not a full-width banner. */}
                <LoadingBanner location={location} camera={camera} />
              </div>
              <NavMenu />
            </div>
          </div>

          {/* System pages (status/detectors/admin) have no title and no tabs —
              they render their own <h1> in the view body — so this row would be
              an empty padded strip. Only mount it when it has content. */}
          {(title || hasTabs) && (
          <div className="topbar-main">
            {title && (
              <div className="title-row">
                <h2>{title}</h2>
                {banner && (
                  <span
                    className={`processing-banner site-${location}`}
                    role="status"
                  >
                    {banner}
                  </span>
                )}
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
              </div>
            )}

            {hasTabs && (
              <div className="tabs">
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
                      // Remember the Table/Channels choice so the next camera
                      // opens on the same tab (setCameraTabPref ignores the
                      // others). CameraTable reads this to redirect on arrival.
                      onClick={() => setCameraTabPref(tab.id)}
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

import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { RubinMark } from "./RubinMark";
import type { ShellNav } from "../lib/useShellNav";
import { cameraDataState } from "../lib/queryClient";

const DOT_TITLE: Record<string, string> = {
  offline: "Offline — this camera is disabled in the configuration.",
  fresh: "Live — this camera has data for the current observing day.",
  stale: "Stale — no data yet for the current observing day; showing an earlier night.",
};

// The app-shell sidebar: brand head, camera pills (real cameras for the active
// location), a System group, the Location list, and a footer theme toggle.
// Ported from the design's Sidebar (design/from-claude/Camera Table - Sidebar
// v2.html) but driven by react-router links + real backend nav data rather than
// the prototype's local state.

interface Props {
  nav: ShellNav;
  onClose: () => void;
}

export function Sidebar({ nav, onClose }: Props) {
  const {
    location,
    camera,
    system,
    locations,
    cameraGroups,
    hasClusterStatus,
  } = nav;

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <div>
          {/* Inline vector mark (shared with the header) so it scales crisply
              and follows the theme accent. A div, not an <h1>: the only RubinTV
              heading is the Home view's. */}
          <RubinMark className="brand-mark" />
          <div className="brand-title">RubinTV</div>
          {location && <div className="site">{location}</div>}
        </div>
        <button
          className="icon-btn"
          onClick={onClose}
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >
          «
        </button>
      </div>

      {cameraGroups.map((group) => (
        <div key={group.label}>
          <div className="group-h">{group.label}</div>
          <div className="cam-pills">
            {group.cameras.map((cam) => {
              const active = cam.name === camera && !system;
              const state = cameraDataState(cam.online, cam.latestDate);
              const className =
                "cam-pill" +
                (active ? " active" : "") +
                (cam.online ? "" : " dim");
              const content = (
                <>
                  <span className={`pdot ${state}`} title={DOT_TITLE[state]} />
                  <span>{cam.title}</span>
                </>
              );
              // Offline cameras aren't navigable (no live page yet).
              return cam.online ? (
                <Link
                  key={cam.name}
                  className={className}
                  to={`/${location}/${cam.name}`}
                  aria-current={active ? "page" : undefined}
                >
                  {content}
                </Link>
              ) : (
                <span key={cam.name} className={className}>
                  {content}
                </span>
              );
            })}
          </div>
        </div>
      ))}

      <div style={{ marginTop: 10 }}>
        <div className="group-h">System</div>
        {hasClusterStatus && (
          <Link
            className={"cam" + (system === "detectors" ? " active" : "")}
            to="/detectors"
            aria-current={system === "detectors" ? "page" : undefined}
          >
            <span>Detectors</span>
            <span className="dot" />
          </Link>
        )}
        <Link
          className={"cam" + (system === "status" ? " active" : "")}
          to="/status"
          aria-current={system === "status" ? "page" : undefined}
        >
          <span>Status</span>
          <span className="dot" />
        </Link>
        <Link
          className={"cam" + (system === "admin" ? " active" : "")}
          to="/admin"
          aria-current={system === "admin" ? "page" : undefined}
        >
          <span>Admin</span>
          <span className="dot" />
        </Link>
      </div>

      {locations.length > 1 && (
        <div style={{ marginTop: 6 }}>
          <div className="group-h">Location</div>
          {locations.map((l) => (
            <Link
              key={l.name}
              className={"cam" + (l.name === location ? " active" : "")}
              to={`/${l.name}`}
              aria-current={l.name === location ? "page" : undefined}
            >
              <span>{l.title}</span>
            </Link>
          ))}
        </div>
      )}

      <div className="sidebar-foot">
        <span className="foot-label">Appearance</span>
        <ThemeToggle />
      </div>
    </div>
  );
}

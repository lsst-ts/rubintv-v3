import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import type { ShellNav } from "../lib/useShellNav";

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
          {/* Brand mark as a CSS background (not an <img>) so it stays out of
              media-image assertions. A div, not an <h1>: the only RubinTV
              heading is the Home view's. */}
          <div
            className="brand-mark"
            role="img"
            aria-label="Vera C. Rubin Observatory"
            style={{
              backgroundImage: 'url("/api/static/rubin-mark.png")',
            }}
          />
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
              const className =
                "cam-pill" +
                (active ? " active" : "") +
                (cam.online ? "" : " dim");
              const content = (
                <>
                  <span className="pdot" />
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

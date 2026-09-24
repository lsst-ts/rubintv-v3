import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ThemeToggle } from "./ThemeToggle";
import { api } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";
import { useSubapps } from "../lib/useSubapps";

// NavMenu — a single hamburger button that opens a compact drawer, replacing
// the app-shell sidebar. It consolidates wayfinding (Home, every location, and
// every app) and tucks the appearance (theme) control behind the same trigger,
// so the theme buttons no longer sit out in the open. Rendered top-right on the
// Home hero and in the topbar's utility strip on every inner page.
//
// Ported from the design's NavMenu (RubinTV Design System, ui_kits/rubintv/
// NavMenu.jsx) but driven by react-router links + the real config API rather
// than the prototype's local state.

// A mounted sub-app path ("/rubintv/ddv") → a drawer link. Mirrors the Home
// page's subappButton: the last path segment is the id, title-cased (short ids
// like "ddv" upper-cased).
function subappLabel(path: string): string {
  const id = path.replace(/\/$/, "").split("/").pop() ?? path;
  return id.length <= 3 ? id.toUpperCase() : id[0].toUpperCase() + id.slice(1);
}

export function NavMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const { data: locations } = useQuery({
    queryKey: queryKeys.locations(),
    queryFn: api.locations,
    staleTime: STALE.config,
  });
  const subapps = useSubapps();

  const locs = Array.isArray(locations) ? locations : [];
  // Cluster status is offered by the drawer when any visible location advertises
  // one — same gate the Home page's Apps section uses.
  const hasClusterStatus = locs.some((l) => l.has_cluster_status);

  const close = () => setOpen(false);

  return (
    <div className="navmenu" ref={ref}>
      <button
        type="button"
        className="navmenu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label="Menu"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <svg
          className="navmenu-glyph"
          viewBox="0 0 24 24"
          width="17"
          height="17"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
        <svg
          className="navmenu-caret"
          viewBox="0 0 24 24"
          width="11"
          height="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="navmenu-pop" role="menu">
          <Link className="navmenu-link" to="/" role="menuitem" onClick={close}>
            Home
          </Link>

          {locs.length > 0 && (
            <>
              <div className="navmenu-sec">Locations</div>
              {locs.map((l) => (
                <Link
                  key={l.name}
                  className="navmenu-link"
                  to={`/${l.name}`}
                  role="menuitem"
                  onClick={close}
                >
                  {l.title}
                </Link>
              ))}
            </>
          )}

          <div className="navmenu-sec">Apps</div>
          {hasClusterStatus && (
            <Link
              className="navmenu-link"
              to="/detectors"
              role="menuitem"
              onClick={close}
            >
              Cluster status
            </Link>
          )}
          {/* Sub-apps live outside the SPA router, so they're plain anchors. */}
          {subapps.map((path) => (
            <a
              key={path}
              className="navmenu-link"
              href={path}
              role="menuitem"
              onClick={close}
            >
              {subappLabel(path)}
            </a>
          ))}
          <Link
            className="navmenu-link"
            to="/status"
            role="menuitem"
            onClick={close}
          >
            Scan status
          </Link>
          <Link
            className="navmenu-link"
            to="/admin"
            role="menuitem"
            onClick={close}
          >
            Admin
          </Link>

          <div className="navmenu-appearance">
            <span className="navmenu-appearance-label">Appearance</span>
            <ThemeToggle />
          </div>
        </div>
      )}
    </div>
  );
}

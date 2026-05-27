import { Link, Outlet, useParams } from "react-router-dom";
import { ConnectionStatus } from "./ConnectionStatus";

// App shell: header with breadcrumbs + connection status, then the routed
// view. Path-based routing means breadcrumbs derive from the URL params, so
// every tab renders its own breadcrumb trail from its own URL (Decision 7).
export function Layout() {
  const { location, camera } = useParams();

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
        <ConnectionStatus />
      </header>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}

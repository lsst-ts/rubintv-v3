import { Link, useLocation, useParams } from "react-router-dom";
import { usePageTitle } from "../lib/usePageTitle";

// The 404 page. Reached two ways: a path that matches no route at all (the
// router's catch-all), and a path that matches a route but names a location,
// camera or channel this deployment doesn't have (useRouteValid). Both land
// here rather than rendering a half-built shell around missing data.
//
// It says which part of the URL was not found, so a mistyped camera doesn't
// read as "the whole site is broken", and offers the two useful ways back:
// the parent page that does exist, and Home.
export function NotFound() {
  const { pathname } = useLocation();
  const { location, camera, channel } = useParams();
  usePageTitle("Not found");

  // Name the missing thing as precisely as the URL allows. The deepest param
  // present is the one that failed validation — the shallower ones were
  // checked first and passed.
  const what = channel
    ? { kind: "channel", name: channel }
    : camera
      ? { kind: "camera", name: camera }
      : location
        ? { kind: "location", name: location }
        : null;

  // Where "back" goes: up one level to the page that does exist. A bad channel
  // falls back to its camera, a bad camera to its location, anything else Home.
  const backTo = channel
    ? `/${location}/${camera}`
    : camera
      ? `/${location}`
      : "/";
  const backLabel = channel ? camera! : camera ? location! : "home";

  return (
    <section className="notfound">
      <p className="notfound-code">404</p>
      <h1 className="notfound-title">
        {what ? `No such ${what.kind}` : "Page not found"}
      </h1>
      <p className="notfound-detail">
        {what ? (
          <>
            There is no {what.kind} named <code>{what.name}</code> in this
            deployment.
          </>
        ) : (
          <>
            Nothing is served at <code>{pathname}</code>.
          </>
        )}
      </p>
      <div className="notfound-actions">
        {backTo !== "/" && (
          <Link className="notfound-link" to={backTo}>
            ← Back to {backLabel}
          </Link>
        )}
        <Link className="notfound-link" to="/">
          Go to home
        </Link>
      </div>
    </section>
  );
}

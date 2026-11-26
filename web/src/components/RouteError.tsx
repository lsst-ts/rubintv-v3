import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useRouteError } from "react-router-dom";
import { BASE } from "../lib/basePath";
import { usePageTitle } from "../lib/usePageTitle";

// What the router draws in place of something that threw while rendering or
// in an effect. Without it react-router replaces the whole app with its own
// "Unexpected Application Error!" page, so one view tripping over a payload
// it didn't expect took the header and navigation with it.
//
// Used at two levels (see routes.tsx). Around the views it is drawn inside
// the shell, which keeps working: the reader can leave by the menu, the
// breadcrumbs or the tabs, and arriving anywhere clears the error. Around the
// shell itself (`whole`) there is nothing left to navigate with, so it offers
// a reload and a plain link home.
export function RouteError({ whole = false }: { whole?: boolean }) {
  const error = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  usePageTitle("Error");

  const message =
    error instanceof Error ? error.message : error != null ? String(error) : "";

  // Draw the view again. Its queries went inactive when it was torn down;
  // dropping them makes it fetch afresh rather than render the same cached
  // payload that may be what it tripped over. Navigating to where we already
  // are is what makes the router let go of the error.
  const retry = () => {
    queryClient.removeQueries({ type: "inactive" });
    navigate(location, { replace: true, state: location.state });
  };

  return (
    <section className="notfound route-error" role="alert">
      <h1 className="notfound-title">
        {whole ? "RubinTV hit an error" : "This page hit an error"}
      </h1>
      <p className="notfound-detail">
        {whole
          ? "The page could not be drawn. Reloading usually clears it."
          : "The page could not be drawn. The rest of RubinTV still works, " +
            "and this page may load if you try it again."}
      </p>
      {message && (
        <p className="notfound-detail">
          <code>{message}</code>
        </p>
      )}
      <div className="notfound-actions">
        {whole ? (
          <>
            <button
              type="button"
              className="notfound-link"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            {/* A plain link, not a <Link>: a full page load starts the app
                again, where a client-side move would keep whatever state
                broke the shell. */}
            <a className="notfound-link" href={`${BASE}/`}>
              Go to home
            </a>
          </>
        ) : (
          <button type="button" className="notfound-link" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </section>
  );
}

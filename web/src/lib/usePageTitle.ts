import { useEffect } from "react";

const SUFFIX = "RubinTV";

// Set document.title to reflect the current page. Pass the page-specific part;
// it's joined with the app name so the browser tab always identifies the app.
// Falsy parts are dropped so a still-loading dynamic title falls back to just
// the app name rather than showing "undefined · RubinTV".
export function usePageTitle(...parts: Array<string | undefined | null | false>) {
  const title = [...parts.filter(Boolean), SUFFIX].join(" · ");
  useEffect(() => {
    document.title = title;
  }, [title]);
}

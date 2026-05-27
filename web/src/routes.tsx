import { RouteObject } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Home } from "./views/Home";
import { Placeholder } from "./views/Placeholder";

// Path-based route table — each path fully describes a tab's state, so a
// deep link restores the exact view on hard reload (Decision 7). The backend
// serves a catch-all -> index.html in production (Phase 7) so these resolve.
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: ":location", element: <Placeholder name="Location" /> },
      { path: ":location/:camera", element: <Placeholder name="Camera Table" /> },
      {
        path: ":location/:camera/night-report",
        element: <Placeholder name="Nightly Summary" />,
      },
      {
        path: ":location/:camera/allsky",
        element: <Placeholder name="All Sky" />,
      },
      {
        path: ":location/:camera/detectors",
        element: <Placeholder name="Detectors" />,
      },
      {
        path: ":location/:camera/admin",
        element: <Placeholder name="Admin" />,
      },
      {
        path: ":location/:camera/mosaic",
        element: <Placeholder name="Mosaic" />,
      },
      // Channel view is last so the more specific suffix routes above win.
      {
        path: ":location/:camera/:channel",
        element: <Placeholder name="Channel" />,
      },
    ],
  },
];

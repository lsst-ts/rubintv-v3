import { RouteObject } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Home } from "./views/Home";
import { Location } from "./views/Location";
import { CameraTable } from "./views/CameraTable";
import { Channel } from "./views/Channel";
import { NightReport } from "./views/NightReport";
import { AllSky } from "./views/AllSky";
import { Detectors } from "./views/Detectors";
import { Admin } from "./views/Admin";
import { Mosaic } from "./views/Mosaic";

// Path-based route table — each path fully describes a tab's state, so a
// deep link restores the exact view on hard reload (Decision 7). The backend
// serves a catch-all -> index.html in production (Phase 7) so these resolve.
// Specific suffix routes precede the channel catch-all.
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: ":location", element: <Location /> },
      { path: ":location/:camera", element: <CameraTable /> },
      { path: ":location/:camera/night-report", element: <NightReport /> },
      { path: ":location/:camera/allsky", element: <AllSky /> },
      { path: ":location/:camera/detectors", element: <Detectors /> },
      { path: ":location/:camera/admin", element: <Admin /> },
      { path: ":location/:camera/mosaic", element: <Mosaic /> },
      { path: ":location/:camera/:channel", element: <Channel /> },
    ],
  },
];

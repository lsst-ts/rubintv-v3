import { RouteObject } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Home } from "./views/Home";
import { Location } from "./views/Location";
import { CameraTable } from "./views/CameraTable";
import { Channel } from "./views/Channel";
import { ChannelBrowser } from "./views/ChannelBrowser";
import { NightReport } from "./views/NightReport";
import { AllSky } from "./views/AllSky";
import { Detectors } from "./views/Detectors";
import { Admin } from "./views/Admin";
import { Mosaic } from "./views/Mosaic";
import { Status } from "./views/Status";

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
      // Site-wide views; these precede :location so their fixed path segments
      // aren't read as location names. Cluster status and admin control
      // readback are deployment-wide (their config lives at the top level,
      // not under a location), so they are not camera sub-pages.
      { path: "status", element: <Status /> },
      { path: "detectors", element: <Detectors /> },
      { path: "admin", element: <Admin /> },
      { path: ":location", element: <Location /> },
      { path: ":location/:camera", element: <CameraTable /> },
      // The Channels tab: a browser of the camera's channels. Precedes the
      // channel catch-all so "channels" isn't read as a channel name.
      { path: ":location/:camera/channels", element: <ChannelBrowser /> },
      { path: ":location/:camera/night-report", element: <NightReport /> },
      { path: ":location/:camera/allsky", element: <AllSky /> },
      { path: ":location/:camera/mosaic", element: <Mosaic /> },
      // Live "current" view: follows the latest image as new exposures arrive,
      // keeping the URL stable. Precedes the channel catch-all so "current" is
      // read as the live suffix, not a seq/date deep link.
      { path: ":location/:camera/:channel/current", element: <Channel live /> },
      { path: ":location/:camera/:channel", element: <Channel /> },
    ],
  },
];

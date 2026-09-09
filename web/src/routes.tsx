import type { ReactElement } from "react";
import { RouteObject } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RouteGuard } from "./components/RouteGuard";
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
import { NotFound } from "./views/NotFound";

// Every route carrying a :location/:camera/:channel param is wrapped so a URL
// naming something this deployment doesn't have renders the 404 page rather
// than a shell around missing data. The guard is transparent until the config
// resolves, so valid deep links render their own skeletons as before.
const guarded = (element: ReactElement) => (
  <RouteGuard>{element}</RouteGuard>
);

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
      { path: ":location", element: guarded(<Location />) },
      { path: ":location/:camera", element: guarded(<CameraTable />) },
      // The Channels tab: a browser of the camera's channels. Precedes the
      // channel catch-all so "channels" isn't read as a channel name.
      { path: ":location/:camera/channels", element: guarded(<ChannelBrowser />) },
      { path: ":location/:camera/night-report", element: guarded(<NightReport />) },
      { path: ":location/:camera/allsky", element: guarded(<AllSky />) },
      { path: ":location/:camera/mosaic", element: guarded(<Mosaic />) },
      // Live "current" view: follows the latest image as new exposures arrive,
      // keeping the URL stable. Precedes the channel catch-all so "current" is
      // read as the live suffix, not a seq/date deep link.
      {
        path: ":location/:camera/:channel/current",
        element: guarded(<Channel live />),
      },
      { path: ":location/:camera/:channel", element: guarded(<Channel />) },
      // Anything deeper or otherwise unmatched (a stray path segment, a typo'd
      // system page) is a 404 — without this react-router renders the Layout
      // with an empty outlet, so a bad URL looked like a blank page. The
      // handle lets the Layout recognise it (it matches no :location param, so
      // there's nothing in useParams to tell it apart from Home) and drop the
      // status pills that have nothing to report on a 404.
      { path: "*", element: <NotFound />, handle: { notFound: true } },
    ],
  },
];

import { useMemo } from "react";
import { useLocation, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { queryKeys } from "./liveQuery";
import { STALE, currentDayObs } from "./queryClient";
import type { CalendarOut, CameraOut } from "./types";

// Derives the app-shell's navigation state from the router + real backend data,
// so the design's Sidebar/topbar (which in the prototype were driven by local
// useState) map onto our path-based routes. Active states come from the URL;
// the camera/location lists come from the same config API the Home/Location
// views already use.

export interface ShellTab {
  id: string;
  label: string;
  // Path relative to /:location/:camera ("" = the Table view itself).
  suffix: string;
  count?: number;
}

// Which tabs a camera offers, derived from its real CameraOut capabilities.
// Table is always present; the others appear only when the backend advertises
// them, so we never link a camera to a view it doesn't have.
export function tabsForCamera(cam: CameraOut | undefined): ShellTab[] {
  // Live-view cameras (e.g. All Sky) have no per-seq table or channel grid —
  // the base camera route is the live panel itself — so they get neither the
  // Table nor Channels tab. A night report is still a distinct view if
  // advertised, so it's added below.
  const tabs: ShellTab[] = cam?.live_view
    ? []
    : [{ id: "table", label: "Table", suffix: "" }];
  if (!cam) return tabs;
  const channels = Array.isArray(cam.channels) ? cam.channels : [];
  const channelCount = channels.filter((c) => !c.per_day).length;
  if (!cam.live_view && channelCount > 0) {
    tabs.push({
      id: "channels",
      label: "Channels",
      suffix: "channels",
      count: channelCount,
    });
  }
  if (cam.night_report_label) {
    tabs.push({
      id: "night-report",
      label: cam.night_report_label || "Night report",
      suffix: "night-report",
    });
  }
  // Note: the live Mosaic is intentionally NOT a tab. It exists only as an
  // embed target (an <iframe> loads /:loc/:cam/mosaic?headerless=true); the
  // in-app movies/plots are served by the Channels viewer instead.
  return tabs;
}

export interface ShellNav {
  location: string;
  camera: string;
  // The site-wide system page in view, if any (detectors/admin/status).
  system: "detectors" | "admin" | "status" | null;
  // The active camera-view tab id (matches a tabsForCamera id).
  activeTab: string;
  locations: { name: string; title: string }[];
  cameraGroups: {
    label: string;
    cameras: {
      name: string;
      title: string;
      online: boolean;
      latestDate: string | null;
    }[];
  }[];
  cameraInfo: CameraOut | undefined;
  hasClusterStatus: boolean;
  isLoading: boolean;
  // The shell-level date state, driving the topbar's date picker. `date` is
  // resolved the same way the Table view resolves it (URL ?date= → newest date
  // → ""), so the picker, the table, and the channel views all agree. Only
  // meaningful on a camera route with a per-date view; empty otherwise.
  date: string;
  calendar: CalendarOut | undefined;
  // The dates the picker offers: the calendar's dates, plus the resolved date
  // spliced in if it's a deep link the scanner hasn't indexed yet (so the
  // trigger shows the day actually being viewed, not a silent fallback).
  pickerDates: string[];
  // Whether `date` is the current observing day (UTC−12 rule); tints the chip.
  isCurrentDayObs: boolean;
  // Adjacent dates with data for the prev/next-day steppers (null at an end).
  olderDate: string | null;
  newerDate: string | null;
}

// System routes that aren't camera sub-pages.
const SYSTEM_PATHS = new Set(["detectors", "admin", "status"]);

export function useShellNav(): ShellNav {
  const params = useParams();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const location = params.location ?? "";
  const camera = params.camera ?? "";

  const first = pathname.split("/")[1] ?? "";
  const system = SYSTEM_PATHS.has(first)
    ? (first as "detectors" | "admin" | "status")
    : null;

  // Active tab from the trailing path segment (night-report / allsky / mosaic),
  // defaulting to the Table view.
  const activeTab = useMemo(() => {
    if (pathname.endsWith("/channels")) return "channels";
    if (pathname.endsWith("/night-report")) return "night-report";
    if (pathname.endsWith("/allsky")) return "allsky";
    if (pathname.endsWith("/mosaic")) return "mosaic";
    // A single-channel view (/:location/:camera/:channel[/current]) is reached
    // from the Channels tab, so it belongs to that tab — not the Table default.
    // Detect it by depth: anything beyond /:location/:camera that wasn't one of
    // the named suffixes above is a channel page.
    if (camera) {
      const segments = pathname.split("/").filter(Boolean);
      const cameraIdx = segments.indexOf(camera);
      if (cameraIdx >= 0 && segments.length > cameraIdx + 1) return "channels";
    }
    return "table";
  }, [pathname, camera]);

  const locationsQ = useQuery({
    queryKey: queryKeys.locations(),
    queryFn: api.locations,
    staleTime: STALE.config,
  });

  // Camera groups for the active location populate the sidebar's camera list.
  const locationQ = useQuery({
    queryKey: queryKeys.location(location),
    queryFn: () => api.location(location),
    staleTime: STALE.config,
    enabled: !!location,
  });

  // Full camera detail drives the tab bar (which views this camera offers).
  const cameraQ = useQuery({
    queryKey: queryKeys.camera(location, camera),
    queryFn: () => api.camera(location, camera),
    staleTime: STALE.config,
    enabled: !!location && !!camera,
  });

  // The calendar feeds the topbar date picker (available dates, exposure
  // counts, max seqs). It's the same query the Table/Channels views issue, so
  // React Query dedupes it — the shell just reads the shared cache slot. Only
  // fetched on a camera route; live-view cameras have no per-date table, so
  // they never show a picker and don't need it.
  const isLiveView = cameraQ.data?.live_view ?? false;
  const calendarQ = useQuery({
    queryKey: queryKeys.calendar(location, camera),
    queryFn: () => api.calendar(location, camera),
    staleTime: STALE.calendar,
    enabled: !!location && !!camera && !isLiveView,
  });
  const calendar = calendarQ.data;
  // Defensive like the rest of the shell: a fetch stub or a backend mid-deploy
  // can return a calendar object with a missing/non-array `dates`, and this
  // hook runs on every camera route — so guard the access rather than let
  // `calendar.dates[0]` throw and blank the whole app.
  const calendarDates = Array.isArray(calendar?.dates) ? calendar.dates : [];

  // Resolve the shell date exactly as the Table view does: an explicit ?date=
  // in the URL, else the newest date with data, else "". Keeping this in one
  // place is what lets the picker, the table, and the channel views agree.
  const date = searchParams.get("date") ?? calendarDates[0] ?? "";

  // The picker must display the date actually in view. A deep-linked date the
  // scanner hasn't indexed yet isn't in the calendar, and a picker whose value
  // matches no option would silently show the newest — so splice it in
  // (newest-first, matching the calendar's order).
  const pickerDates = useMemo(() => {
    if (!date || calendarDates.includes(date)) return calendarDates;
    return [...calendarDates, date].sort().reverse();
  }, [calendarDates, date]);

  // Adjacent dates with data for the prev/next-day steppers. pickerDates is
  // newest-first, so the older day sits at index+1 and the newer at index-1.
  const dateIdx = pickerDates.indexOf(date);
  const olderDate =
    dateIdx >= 0 && dateIdx < pickerDates.length - 1
      ? pickerDates[dateIdx + 1]
      : null;
  const newerDate = dateIdx > 0 ? pickerDates[dateIdx - 1] : null;

  // Whether the viewed date is the live observing day (UTC−12 rollover). This
  // is the same distinction the Table and Channels views draw: "newest date
  // with data" can still be an old night when observing has paused.
  const isCurrentDayObs = date !== "" && date === currentDayObs();

  // Defensive: fetch stubs (and a backend mid-deploy) can return non-arrays;
  // never let the shell crash the whole app over malformed nav data.
  const rawLocations = Array.isArray(locationsQ.data) ? locationsQ.data : [];
  const rawGroups = Array.isArray(locationQ.data?.camera_groups)
    ? locationQ.data.camera_groups
    : [];

  return {
    location,
    camera,
    system,
    activeTab,
    locations: rawLocations.map((l) => ({ name: l.name, title: l.title })),
    cameraGroups: rawGroups.map((g) => ({
      label: g.label,
      cameras: (Array.isArray(g.cameras) ? g.cameras : []).map((c) => ({
        name: c.name,
        title: c.title,
        online: c.online,
        latestDate: c.latest_date ?? null,
      })),
    })),
    cameraInfo: cameraQ.data,
    hasClusterStatus: locationQ.data?.has_cluster_status ?? false,
    isLoading: locationsQ.isPending,
    date,
    calendar,
    pickerDates,
    isCurrentDayObs,
    olderDate,
    newerDate,
  };
}

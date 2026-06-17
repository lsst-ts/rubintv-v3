import { useMemo } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { queryKeys } from "./liveQuery";
import { STALE } from "./queryClient";
import type { CameraOut } from "./types";

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
  const tabs: ShellTab[] = [{ id: "table", label: "Table", suffix: "" }];
  if (!cam) return tabs;
  const channels = Array.isArray(cam.channels) ? cam.channels : [];
  const channelCount = channels.filter((c) => !c.per_day).length;
  if (channelCount > 0) {
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
    cameras: { name: string; title: string; online: boolean }[];
  }[];
  cameraInfo: CameraOut | undefined;
  hasClusterStatus: boolean;
  isLoading: boolean;
}

// System routes that aren't camera sub-pages.
const SYSTEM_PATHS = new Set(["detectors", "admin", "status"]);

export function useShellNav(): ShellNav {
  const params = useParams();
  const { pathname } = useLocation();
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
    return "table";
  }, [pathname]);

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
      })),
    })),
    cameraInfo: cameraQ.data,
    hasClusterStatus: locationQ.data?.has_cluster_status ?? false,
    isLoading: locationsQ.isPending,
  };
}

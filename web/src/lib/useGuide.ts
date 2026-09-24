import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { STALE } from "./queryClient";
import type { GuideConfigOut } from "./types";

// The observing-block guide's configuration: whether this deployment has a
// ConsDB to build it from, and which instruments it covers. Static for the
// process lifetime, like locations. Shared by the nav drawer, the Home page's
// Apps section (both show the link only when enabled) and the Guide view.
export function useGuideConfig(): GuideConfigOut | undefined {
  const { data } = useQuery({
    queryKey: ["guide", "config"],
    queryFn: api.guideConfig,
    staleTime: STALE.config,
  });
  return data;
}

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { STALE } from "./queryClient";

// Mounted sub-apps (DDV, exp_checker) are reported by the backend; consumers
// render links to whatever is available. Sub-apps live outside the SPA router,
// so their paths are used as plain anchors. Shared by the header nav (Layout)
// and the Home page's "Apps" section.
export function useSubapps(): string[] {
  const { data } = useQuery({
    queryKey: ["subapps"],
    queryFn: api.subapps,
    staleTime: STALE.config,
  });
  return data?.mounted ?? [];
}

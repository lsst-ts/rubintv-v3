import { createContext, useContext } from "react";

// Reports that a media download (an image or movie) on the page was cut short
// mid-transfer. The shell (Layout) provides it and shows a "Download
// interrupted · Reload" notice; outside the shell (tests, a bare component)
// reporting is a no-op.
const MediaInterruptionContext = createContext<() => void>(() => {});

export const MediaInterruptionProvider = MediaInterruptionContext.Provider;

export function useReportInterruption(): () => void {
  return useContext(MediaInterruptionContext);
}

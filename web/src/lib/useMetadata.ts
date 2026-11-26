// The metadata for one (location, camera, date), kept current. Shared by the
// camera table, the channel viewer's sidebar and the mosaic captions, so all
// three load and refresh it the same way.
//
// It loads apart from the date payload, so the grid never waits on it, and
// over REST alone: see lib/metadata for how one document is fetched once
// and then brought forward by differences.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "./liveQuery";
import { fetchMetadata, type MetadataDoc } from "./metadata";
import { staleTimeForDate } from "./queryClient";
import type { Metadata } from "./types";

export interface MetadataView {
  metadata: Metadata;
  /** True once a document has arrived. */
  loaded: boolean;
  /** True while the first document is on its way. */
  loading: boolean;
  /** True when no document could be fetched (S3 or the server is failing).
   *  The next rewrite, reconnect or visit tries again. */
  failed: boolean;
}

// One object for "no rows yet", so consumers' memos don't see a new value
// on every render while the document loads.
const NO_ROWS: Metadata = {};

export function useMetadata(
  location: string,
  camera: string,
  date: string,
): MetadataView {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery<MetadataDoc>({
    queryKey: queryKeys.metadata(location, camera, date),
    queryFn: () => fetchMetadata(qc, location, camera, date),
    enabled: date !== "",
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
    // fetchMetadata keeps unchanged rows (and an unchanged document) as the
    // same objects itself; the default would deep-compare the whole document
    // against the last on every fetch.
    structuralSharing: false,
  });
  return {
    metadata: data?.rows ?? NO_ROWS,
    loaded: data !== undefined,
    loading: isLoading,
    failed: isError && data === undefined,
  };
}

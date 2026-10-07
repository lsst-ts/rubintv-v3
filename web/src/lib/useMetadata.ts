// Metadata for a (location, camera, date) as the views render it.
//
// The WebSocket stream is the delivery path: subscribing with a date makes the
// server stream metadata.json in chunks (from its cache when it has it), and a
// metadata change re-runs the stream. The REST metadata.json request is only
// the backstop, enabled when the stream can't deliver — the socket is down, or
// the last stream finished with chunks missing (the server drops frames for a
// slow client). Firing REST alongside the stream used to double the transfer,
// and the request queued behind the server's download of the same file.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useLive } from "./LiveContext";
import {
  queryKeys,
  resetMetadataStream,
  type Metadata as LiveMetadata,
  type MetadataProgress,
  type MetadataStreamStatus,
} from "./liveQuery";
import { staleTimeForDate } from "./queryClient";
import type { Metadata } from "./types";

// A socket still "connecting" after this long is treated as down for the
// backstop's purposes: the stream is not about to start. Comfortably longer
// than a WebSocket handshake even over a VPN, so a normal page load never
// fires REST alongside the stream. Zero under vitest, whose stub socket never
// connects — there the backstop is the only path, as it would be with no
// server.
const CONNECT_GRACE_MS = import.meta.env.MODE === "test" ? 0 : 2000;

export interface MetadataView {
  metadata: Metadata;
  /** Rows streamed so far, or null when no stream is in flight. */
  progress: MetadataProgress | null;
  /** True once a full document has arrived by either path. */
  loaded: boolean;
}

export function useMetadata(
  location: string,
  camera: string,
  date: string,
): MetadataView {
  const qc = useQueryClient();
  const { status: socket } = useLive();

  // These slots are PUSHED by applyLiveMessage via setQueryData; the fetcher
  // must only reflect the cache, never produce a default — a queryFn returning
  // `null`/`{}` would run on mount and clobber what the stream just pushed.
  // Returning the cached value keeps the fetcher inert while still registering
  // one (no "missing queryFn" warning); staleTime:Infinity stops refetches.
  const progressKey = queryKeys.metadataProgress(location, camera, date);
  const { data: progress } = useQuery<MetadataProgress | null>({
    queryKey: progressKey,
    queryFn: () => qc.getQueryData<MetadataProgress | null>(progressKey) ?? null,
    staleTime: Infinity,
  });
  const streamKey = queryKeys.metadataStream(location, camera, date);
  const { data: streamed } = useQuery<LiveMetadata>({
    queryKey: streamKey,
    queryFn: () => qc.getQueryData<LiveMetadata>(streamKey) ?? {},
    staleTime: Infinity,
  });
  const statusKey = queryKeys.metadataStreamStatus(location, camera, date);
  const { data: streamStatus } = useQuery<MetadataStreamStatus | null>({
    queryKey: statusKey,
    queryFn: () => qc.getQueryData<MetadataStreamStatus | null>(statusKey) ?? null,
    staleTime: Infinity,
  });

  // "connecting" is the initial state on every page load: not a reason to
  // fetch, the stream is about to start — unless it stays that way past the
  // grace period. "closed" is a real drop.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (socket !== "connecting") {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), CONNECT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [socket]);
  const needRest =
    socket === "closed" || stalled || streamStatus === "incomplete";
  const {
    data: rest,
    isSuccess: restLoaded,
    dataUpdatedAt: restUpdatedAt,
  } = useQuery<Metadata>({
    queryKey: queryKeys.metadata(location, camera, date),
    queryFn: () => api.metadata(location, camera, date),
    enabled: date !== "" && needRest,
    staleTime: date ? staleTimeForDate(new Date(date)) : 0,
  });

  // A fresh REST document is complete as of its fetch time, so the stream
  // accumulation is dropped then (a row deleted server-side would otherwise
  // survive in the add-only slot). Chunks arriving afterwards re-accumulate.
  useEffect(() => {
    if (!restUpdatedAt) return;
    resetMetadataStream(qc, location, camera, date);
  }, [qc, location, camera, date, restUpdatedAt]);

  const metadata = useMemo<Metadata>(
    () => ({ ...(streamed ?? {}), ...(rest ?? {}) }) as Metadata,
    [streamed, rest],
  );
  return {
    metadata,
    progress: progress ?? null,
    loaded: restLoaded || streamStatus === "complete",
  };
}

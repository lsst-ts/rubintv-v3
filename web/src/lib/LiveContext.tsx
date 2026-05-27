// Owns this tab's single WebSocket and wires incoming messages into the
// TanStack Query cache. Views call useLiveTopic(...) to subscribe to the
// data their route needs; subscriptions are released on unmount/navigation.

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWebSocket, type Subscription } from "./ws";
import { applyLiveMessage, type ServerMessage } from "./liveQuery";

interface LiveValue {
  subscribe: (sub: Subscription) => () => void;
  status: "connecting" | "open" | "closed";
}

const LiveContext = createContext<LiveValue | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { status, subscribe, onMessage } = useWebSocket();

  useEffect(
    () => onMessage((msg) => applyLiveMessage(qc, msg as ServerMessage)),
    [onMessage, qc],
  );

  return (
    <LiveContext.Provider value={{ subscribe, status }}>
      {children}
    </LiveContext.Provider>
  );
}

export function useLive(): LiveValue {
  const ctx = useContext(LiveContext);
  if (ctx === null) throw new Error("useLive must be used within LiveProvider");
  return ctx;
}

/** Subscribe to a live topic for the lifetime of the calling component. */
export function useLiveTopic(sub: Subscription | null): void {
  const { subscribe } = useLive();
  const key = sub ? JSON.stringify(sub) : null;
  useEffect(() => {
    if (sub === null) return;
    return subscribe(sub);
    // key captures the meaningful identity of sub.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, subscribe]);
}

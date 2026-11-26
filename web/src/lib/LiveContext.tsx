// Owns this tab's single WebSocket and wires incoming messages into the
// TanStack Query cache. Views call useLiveTopic(...) to subscribe to the
// data their route needs; subscriptions are released on unmount/navigation.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWebSocket, type ConnectionStatus, type Subscription } from "./ws";
import { applyLiveMessage, type ServerMessage } from "./liveQuery";

interface LiveValue {
  subscribe: (sub: Subscription) => () => void;
  status: ConnectionStatus;
  // The socket has been down for longer than a blip, so the page is not
  // receiving updates. What the shell's indicators go by, not `status`.
  disconnected: boolean;
  // How many times the socket has come back after a drop. Queries are
  // refetched on each (see onReconnect); anything else that failed while it
  // was down watches this to try again.
  reconnects: number;
}

const LiveContext = createContext<LiveValue | null>(null);

// How long the socket may be down before the page says so. The first connect
// and a quick reconnect (a network blip) fit inside it, so the indicators
// don't flash on every page load.
export const DISCONNECT_GRACE_MS = 5000;

function useDisconnected(status: ConnectionStatus): boolean {
  const [disconnected, setDisconnected] = useState(false);
  // "connecting" and "closed" alternate while the socket retries; neither
  // restarts the clock.
  const open = status === "open";
  useEffect(() => {
    if (open) {
      setDisconnected(false);
      return;
    }
    const id = setTimeout(() => setDisconnected(true), DISCONNECT_GRACE_MS);
    return () => clearTimeout(id);
  }, [open]);
  return disconnected;
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  // After the socket reconnects, refetch everything: live updates are deltas,
  // so any change during the outage (e.g. exposures that landed while the
  // backend redeployed) is otherwise lost until the next event for that topic —
  // which at end of night may never come. Invalidate active queries so the
  // views resync to REST truth; the resubscribe (in the hook) resumes deltas.
  const [reconnects, setReconnects] = useState(0);
  const onReconnect = useCallback(() => {
    qc.invalidateQueries();
    setReconnects((n) => n + 1);
  }, [qc]);
  const { status, subscribe, onMessage, retryNow } = useWebSocket(undefined, {
    onReconnect,
  });
  const disconnected = useDisconnected(status);

  // The status poll getting an answer says the server is reachable, so a
  // socket waiting to retry tries at once. While a server is down the
  // retries thin out to one every 10 s, and the pages that poll its status
  // (every 5 s) would otherwise show it back before they are live again.
  // Only that poll: its steady pace bounds the extra tries where the server
  // answers HTTP but won't take a WebSocket.
  useEffect(
    () =>
      qc.getQueryCache().subscribe((event) => {
        if (
          event.type === "updated" &&
          event.action.type === "success" &&
          event.query.queryKey[0] === "status"
        ) {
          retryNow();
        }
      }),
    [qc, retryNow],
  );

  useEffect(
    () => onMessage((raw) => applyLiveMessage(qc, raw as ServerMessage)),
    [onMessage, qc],
  );

  return (
    <LiveContext.Provider
      value={{ subscribe, status, disconnected, reconnects }}
    >
      {children}
    </LiveContext.Provider>
  );
}

export function useLive(): LiveValue {
  const ctx = useContext(LiveContext);
  if (ctx === null) throw new Error("useLive must be used within LiveProvider");
  return ctx;
}

/** The count of reconnects, as an effect dependency: it changes each time the
 *  tab's connection comes back. Outside the provider (a bare component) it
 *  never does. */
export function useReconnects(): number {
  return useContext(LiveContext)?.reconnects ?? 0;
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

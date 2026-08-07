// WebSocket hook — ONE connection per tab (Decision 7). Each tab is an
// independent SPA instance; this hook owns that tab's single socket, handles
// reconnection, and lets views subscribe to topics driven by the route.
//
// The server protocol is typed (Phase 4); here we model the message shapes
// and the connection lifecycle. Until the backend /ws endpoint exists, the
// hook connects, retries with backoff, and surfaces status without error
// spam.

import { useCallback, useEffect, useRef, useState } from "react";
import { BASE } from "./basePath";
import { debugLog } from "./debug";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface Subscription {
  topic: string;
  location?: string;
  camera?: string;
  channel?: string;
  // When set on a camera subscription, the server streams that date's
  // metadata to this tab as metadataChunk frames (progressive fill).
  date?: string;
}

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

type MessageHandler = (msg: ServerMessage) => void;

const MAX_BACKOFF_MS = 10_000;

/**
 * Manage this tab's single WebSocket connection.
 *
 * Returns the connection status, a `subscribe` function (which sends a
 * subscribe frame and re-sends it after any reconnect), and an `onMessage`
 * registrar.
 */
export interface WebSocketOptions {
  // Called after the socket re-opens following a drop (NOT the first connect).
  // The caller uses it to refetch data that may have changed while the socket
  // was down — live updates are delta-driven, so anything missed during the
  // outage would otherwise never appear until the next event for that topic.
  onReconnect?: () => void;
}

export function useWebSocket(
  url = `${BASE}/ws`,
  { onReconnect }: WebSocketOptions = {},
) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  // Keyed by the serialised subscription, refcounted: several consumers can
  // subscribe to an identical topic (e.g. CameraTable and AllSky for the same
  // camera/date), and the server must only see one subscribe/unsubscribe pair
  // for the lot — otherwise the first consumer's cleanup would kill the
  // survivors' stream.
  const subscriptionsRef = useRef<
    Map<string, { sub: Subscription; count: number }>
  >(new Map());
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const backoffRef = useRef(500);
  // True once the first connection has opened, so we can distinguish the
  // initial open (no refetch needed — queries load themselves) from a
  // reconnect after a drop (refetch what was missed).
  const hasConnectedRef = useRef(false);
  // Keep the latest callback without making the connect effect depend on it
  // (which would tear down and rebuild the socket whenever it changes).
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  const send = useCallback((data: unknown) => {
    const sock = socketRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      debugLog("ws.send", data);
      sock.send(JSON.stringify(data));
    } else {
      debugLog("ws.send.dropped", "socket not open", data);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${window.location.host}${url}`);
      socketRef.current = sock;
      setStatus("connecting");

      sock.onopen = () => {
        if (cancelled) {
          sock.close();
          return;
        }
        setStatus("open");
        backoffRef.current = 500;
        // Replay subscriptions after a reconnect — once per unique topic,
        // regardless of how many consumers hold it.
        for (const { sub } of subscriptionsRef.current.values()) {
          send({ action: "subscribe", ...sub });
        }
        // On a *re*connect (not the first open), refetch: data may have
        // changed while the socket was down and live deltas for it are gone.
        if (hasConnectedRef.current) {
          onReconnectRef.current?.();
        }
        hasConnectedRef.current = true;
      };

      sock.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as ServerMessage;
          if (msg.type === "metadataChunk" || msg.type === "metadataComplete") {
            debugLog("ws.recv", msg.type, {
              camera: msg.camera,
              date: msg.date,
              seq: msg.seq,
              total: msg.total,
              rows:
                msg.data && typeof msg.data === "object"
                  ? Object.keys(msg.data as object).length
                  : undefined,
            });
          }
          handlersRef.current.forEach((h) => h(msg));
        } catch {
          // Ignore non-JSON frames.
        }
      };

      sock.onclose = () => {
        if (cancelled) return;
        setStatus("closed");
        const delay = Math.min(backoffRef.current, MAX_BACKOFF_MS);
        backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
    // send is stable (useCallback with no deps); url is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const subscribe = useCallback(
    (sub: Subscription) => {
      const key = JSON.stringify(sub);
      const entry = subscriptionsRef.current.get(key);
      if (entry) {
        // Another consumer already holds this topic; just refcount it.
        entry.count += 1;
      } else {
        subscriptionsRef.current.set(key, { sub, count: 1 });
        send({ action: "subscribe", ...sub });
      }
      let released = false;
      return () => {
        // Guard against a cleanup running twice (harmless in React's normal
        // lifecycle, but it must not decrement another consumer's hold).
        if (released) return;
        released = true;
        const cur = subscriptionsRef.current.get(key);
        if (!cur) return;
        cur.count -= 1;
        if (cur.count <= 0) {
          subscriptionsRef.current.delete(key);
          send({ action: "unsubscribe", ...sub });
        }
      };
    },
    [send],
  );

  const onMessage = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  return { status, subscribe, onMessage };
}

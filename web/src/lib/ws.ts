// WebSocket hook — ONE connection per tab (Decision 7). Each tab is an
// independent SPA instance; this hook owns that tab's single socket, handles
// reconnection, and lets views subscribe to topics driven by the route.
//
// The server protocol is typed (Phase 4); here we model the message shapes
// and the connection lifecycle. Until the backend /ws endpoint exists, the
// hook connects, retries with backoff, and surfaces status without error
// spam.

import { useCallback, useEffect, useRef, useState } from "react";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface Subscription {
  topic: string;
  location?: string;
  camera?: string;
  channel?: string;
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
export function useWebSocket(url = "/ws") {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const subscriptionsRef = useRef<Map<string, Subscription>>(new Map());
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const backoffRef = useRef(500);

  const send = useCallback((data: unknown) => {
    const sock = socketRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(data));
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
        // Replay subscriptions after a reconnect.
        for (const sub of subscriptionsRef.current.values()) {
          send({ action: "subscribe", ...sub });
        }
      };

      sock.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as ServerMessage;
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
      subscriptionsRef.current.set(key, sub);
      send({ action: "subscribe", ...sub });
      return () => {
        subscriptionsRef.current.delete(key);
        send({ action: "unsubscribe", ...sub });
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

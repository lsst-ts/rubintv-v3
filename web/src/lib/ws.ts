// WebSocket hook — ONE connection per tab (Decision 7). Each tab is an
// independent SPA instance; this hook owns that tab's single socket, handles
// reconnection, and lets views subscribe to topics driven by the route.
//
// The server protocol is typed (ws/protocol.py); here we model the message
// shapes and the connection lifecycle: connect, retry with backoff (or at
// once, when told the server is back), give up on a socket that has gone
// silent, and surface status.

import { useCallback, useEffect, useRef, useState } from "react";
import { BASE } from "./basePath";
import { debugLog } from "./debug";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface Subscription {
  topic: string;
  location?: string;
  camera?: string;
}

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

type MessageHandler = (msg: ServerMessage) => void;

const MAX_BACKOFF_MS = 10_000;
// The server sends a heartbeat on any connection it has had nothing else to
// say on for 20 s (ws/handler.py), so a live socket is never silent for long.
// One that is has died without closing (a laptop that slept, a proxy that
// dropped the route) and the browser can take many minutes to notice, so past
// this limit the tab gives up on it and reconnects. Two heartbeats and a
// margin, so one late frame doesn't cost a reconnect.
export const SILENCE_LIMIT_MS = 45_000;

/**
 * Manage this tab's single WebSocket connection.
 *
 * Returns the connection status, a `subscribe` function (which sends a
 * subscribe frame and re-sends it after any reconnect), an `onMessage`
 * registrar, and `retryNow`, which starts the retry a lost connection is
 * waiting to make.
 */
export interface WebSocketOptions {
  // Called when a socket opens after one was lost: a reconnect following a
  // drop, or the first connect of a tab if its earlier tries failed (it was
  // opened while the server was unreachable). Not a first connect that just
  // works. The caller uses it to refetch data that may have changed while the
  // socket was down — live updates are delta-driven, so anything missed
  // during the outage would otherwise never appear until the next event for
  // that topic — and to retry what failed meanwhile.
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
  // True from a socket being lost until the next one opens, so we can tell an
  // open that just works (no refetch needed — queries load themselves) from
  // one that ends an outage (refetch what was missed, retry what failed).
  const lostSinceOpenRef = useRef(false);
  // Keep the latest callback without making the connect effect depend on it
  // (which would tear down and rebuild the socket whenever it changes).
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;
  // The connect effect's "retry now", for retryNow below.
  const retryRef = useRef<() => void>(() => {});

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
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${window.location.host}${url}`);
      socketRef.current = sock;
      setStatus("connecting");

      // This socket is finished — the other end closed it, or it went silent —
      // so retry on a new one. Once per socket: a socket given up on for
      // silence still fires its own close later.
      let lost = false;
      const onLost = () => {
        if (cancelled || lost) return;
        lost = true;
        lostSinceOpenRef.current = true;
        clearTimeout(silenceTimer);
        setStatus("closed");
        const delay = Math.min(backoffRef.current, MAX_BACKOFF_MS);
        backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, delay);
      };
      // Restart the silence clock: at creation (a connect that hangs is as
      // dead as a socket that stops talking), on open, and on every frame.
      // The clock is the current socket's: a late frame from one already
      // given up on must not hold its replacement's back.
      const heard = () => {
        if (cancelled || lost) return;
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          debugLog("ws.silent", "no frame for", SILENCE_LIMIT_MS, "ms");
          sock.close();
          onLost();
        }, SILENCE_LIMIT_MS);
      };
      heard();

      sock.onopen = () => {
        if (cancelled) {
          sock.close();
          return;
        }
        setStatus("open");
        heard();
        backoffRef.current = 500;
        // Replay subscriptions after a reconnect — once per unique topic,
        // regardless of how many consumers hold it.
        for (const { sub } of subscriptionsRef.current.values()) {
          send({ action: "subscribe", ...sub });
        }
        // An open that ends an outage: data may have changed while the socket
        // was down and live deltas for it are gone, and requests made
        // meanwhile failed.
        if (lostSinceOpenRef.current) {
          onReconnectRef.current?.();
        }
        lostSinceOpenRef.current = false;
      };

      sock.onmessage = (ev) => {
        heard();
        try {
          const msg = JSON.parse(ev.data) as ServerMessage;
          // A heartbeat only says the socket is alive, which `heard` noted.
          if (msg.type === "heartbeat") return;
          handlersRef.current.forEach((h) => h(msg));
        } catch {
          // Ignore non-JSON frames.
        }
      };

      sock.onclose = onLost;
    };

    // Only a retry that is waiting out its delay can be brought forward:
    // with a socket open, or a try under way, there is nothing to hurry.
    retryRef.current = () => {
      if (cancelled || reconnectTimer === undefined) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      debugLog("ws.retry.now");
      connect();
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearTimeout(silenceTimer);
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

  // Retry now, not when the backoff delay runs out. The delays grow to
  // MAX_BACKOFF_MS while a server is down, so a tab would otherwise learn it
  // is back up to that long after it is. For a caller with other evidence
  // that the server is reachable again; does nothing unless a retry is
  // waiting. If the try fails, the backoff carries on from where it was.
  const retryNow = useCallback(() => retryRef.current(), []);

  return { status, subscribe, onMessage, retryNow };
}

"""Connection manager and subscription registry.

Tracks live sockets and which topics each is subscribed to, so fan-out is a
dict lookup (``topic_key -> connections``) rather than a scan of all
clients. Each connection has a bounded send queue; a client that can't keep
up is dropped rather than buffering unboundedly (backpressure).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from uuid import uuid4

from fastapi import WebSocket

from rubintv.logging import get_logger
from rubintv.ws.protocol import ServerMessage

log = get_logger(__name__)

_SEND_QUEUE_MAX = 256


@dataclass
class Connection:
    """One client socket with its outbound queue and subscriptions."""

    id: str
    socket: WebSocket
    queue: asyncio.Queue[ServerMessage] = field(
        default_factory=lambda: asyncio.Queue(maxsize=_SEND_QUEUE_MAX)
    )
    topics: set[str] = field(default_factory=set)


class ConnectionManager:
    """Holds connections and the topic -> connections index."""

    def __init__(self) -> None:
        self._connections: dict[str, Connection] = {}
        self._by_topic: dict[str, set[str]] = {}

    async def connect(self, socket: WebSocket) -> Connection:
        await socket.accept()
        conn = Connection(id=str(uuid4()), socket=socket)
        self._connections[conn.id] = conn
        log.info("ws.connect", conn=conn.id, total=len(self._connections))
        return conn

    def disconnect(self, conn: Connection) -> None:
        for topic in conn.topics:
            subs = self._by_topic.get(topic)
            if subs is not None:
                subs.discard(conn.id)
                if not subs:
                    del self._by_topic[topic]
        self._connections.pop(conn.id, None)
        log.info("ws.disconnect", conn=conn.id, total=len(self._connections))

    def subscribe(self, conn: Connection, topic_key: str) -> None:
        conn.topics.add(topic_key)
        self._by_topic.setdefault(topic_key, set()).add(conn.id)

    def unsubscribe(self, conn: Connection, topic_key: str) -> None:
        conn.topics.discard(topic_key)
        subs = self._by_topic.get(topic_key)
        if subs is not None:
            subs.discard(conn.id)
            if not subs:
                del self._by_topic[topic_key]

    def publish_to_topic(self, topic_key: str, message: ServerMessage) -> None:
        """Enqueue a message for every connection subscribed to a topic.

        A full queue means the client is too slow; we drop the message for
        that client (logged) rather than block.
        """
        for conn_id in self._by_topic.get(topic_key, set()):
            conn = self._connections.get(conn_id)
            if conn is None:
                continue
            self.send_to(conn, message)

    def send_to(self, conn: Connection, message: ServerMessage) -> None:
        """Enqueue a message for one connection, dropping if it's too slow.

        Same backpressure policy as fan-out: a full queue means the client
        can't keep up, so we drop rather than block the producer.
        """
        try:
            conn.queue.put_nowait(message)
        except asyncio.QueueFull:
            log.warning("ws.client.slow", conn=conn.id, type=message.type)

    @property
    def connection_count(self) -> int:
        return len(self._connections)

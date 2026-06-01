"""The /ws endpoint and the bus pump.

The pump subscribes to the EventBus and, for each ``StoreChange``, computes
the affected topic key(s) and fans a typed ``ServerMessage`` to subscribers
via the ConnectionManager. The endpoint handles one client: accept, read
subscribe/unsubscribe frames, and drain its send queue concurrently.

On (re)subscribe to a camera/nightReport topic, the server immediately sends
the current snapshot for that topic so a freshly opened tab is correct
without waiting for the next change.
"""

from __future__ import annotations

import asyncio

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from rubintv.data.events import StoreChange
from rubintv.data.metadata import MetadataCache
from rubintv.data.store import EventStore
from rubintv.logging import get_logger
from rubintv.ws.manager import Connection, ConnectionManager
from rubintv.ws.protocol import ServerMessage, SubscribeRequest

log = get_logger(__name__)

# Seq-nums per metadataChunk frame. Small enough that the first rows appear
# almost immediately and a slow client only drops a chunk's worth; large
# enough that a full day (~thousands of rows) is a handful of frames.
_METADATA_CHUNK_SIZE = 200

# Map a StoreChange.type to the topic kind that cares about it.
_CHANGE_TO_TOPIC = {
    "channelData": "camera",
    "metadata": "camera",
    "perDay": "camera",
    "nightReport": "nightReport",
    "dayChange": "camera",
    "calendar": "camera",
}


class WsService:
    """Owns the connection manager and the bus pump task."""

    def __init__(self, store: EventStore, metadata: MetadataCache) -> None:
        self._store = store
        self._metadata = metadata
        self.manager = ConnectionManager()
        self._pump_task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._pump_task = asyncio.create_task(self._pump(), name="ws-bus-pump")

    async def stop(self) -> None:
        if self._pump_task is not None:
            self._pump_task.cancel()
            await asyncio.gather(self._pump_task, return_exceptions=True)

    async def _pump(self) -> None:
        """Translate bus changes into client messages."""
        async with self._store.bus.subscribe() as stream:
            async for change in stream:
                self._fan_out(change)

    def _fan_out(self, change: StoreChange) -> None:
        topic_kind = _CHANGE_TO_TOPIC.get(change.type)
        if topic_kind is None:
            return
        topic_key = "|".join([topic_kind, change.location, change.camera or "", ""])
        msg = ServerMessage(
            type=change.type,
            location=change.location,
            camera=change.camera,
            date=change.date,
        )
        self.manager.publish_to_topic(topic_key, msg)

    # -- per-connection handling ----------------------------------------

    async def handle(self, socket: WebSocket) -> None:
        conn = await self.manager.connect(socket)
        sender = asyncio.create_task(self._send_loop(conn))
        stream_tasks: set[asyncio.Task[None]] = set()
        try:
            await self._recv_loop(conn, stream_tasks)
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            for task in stream_tasks:
                task.cancel()
            await asyncio.gather(sender, *stream_tasks, return_exceptions=True)
            self.manager.disconnect(conn)

    async def _recv_loop(
        self, conn: Connection, stream_tasks: set[asyncio.Task[None]]
    ) -> None:
        while True:
            raw = await conn.socket.receive_text()
            try:
                req = SubscribeRequest.model_validate_json(raw)
            except ValidationError as exc:
                await conn.socket.send_text(
                    ServerMessage(type="error", message=str(exc)).model_dump_json()
                )
                continue
            if req.action == "subscribe":
                self.manager.subscribe(conn, req.topic_key())
                self._send_snapshot(conn, req)
                if req.topic == "camera" and req.camera and req.date:
                    self._start_metadata_stream(conn, req, stream_tasks)
            else:
                self.manager.unsubscribe(conn, req.topic_key())

    def _start_metadata_stream(
        self,
        conn: Connection,
        req: SubscribeRequest,
        stream_tasks: set[asyncio.Task[None]],
    ) -> None:
        """Launch a background task streaming a date's metadata to one client."""
        task = asyncio.create_task(
            self._stream_metadata(
                conn, req.location, req.camera or "", req.date or ""
            )
        )
        stream_tasks.add(task)
        task.add_done_callback(stream_tasks.discard)

    async def _stream_metadata(
        self, conn: Connection, location: str, camera: str, date: str
    ) -> None:
        """Fetch a date's metadata and fan it to one client in chunks.

        Reuses MetadataCache (cache + ETag dedupe + the S3 round-trip on a
        worker thread). Chunks are enqueued on the connection's bounded queue;
        a chunk dropped for a slow client is tolerated — the REST date payload
        remains the authoritative metadata source.
        """
        try:
            etag, data = await self._metadata.get_with_etag(location, camera, date)
        except Exception:  # noqa: BLE001 - never let one stream kill the socket
            log.exception("ws.metadata.fetch.error", camera=camera, date=date)
            return

        items = list(data.items())
        total = max(1, -(-len(items) // _METADATA_CHUNK_SIZE))  # ceil-div
        for i in range(0, len(items), _METADATA_CHUNK_SIZE):
            chunk = dict(items[i : i + _METADATA_CHUNK_SIZE])
            self.manager.send_to(
                conn,
                ServerMessage(
                    type="metadataChunk",
                    location=location,
                    camera=camera,
                    date=date,
                    seq=i // _METADATA_CHUNK_SIZE,
                    total=total,
                    data=chunk,
                ),
            )
            # Yield so a large payload doesn't starve the pump or other streams.
            await asyncio.sleep(0)
        self.manager.send_to(
            conn,
            ServerMessage(
                type="metadataComplete",
                location=location,
                camera=camera,
                date=date,
                total=total,
                etag=etag,
            ),
        )

    async def _send_loop(self, conn: Connection) -> None:
        while True:
            msg = await conn.queue.get()
            await conn.socket.send_text(msg.model_dump_json())

    def _send_snapshot(self, conn: Connection, req: SubscribeRequest) -> None:
        """Push the current state for a freshly subscribed camera topic."""
        if req.topic != "camera" or req.camera is None:
            # Channel/detector/admin snapshots are added with their data
            # sources; camera is the one the store can answer directly.
            return
        snapshot = ServerMessage(
            type="channelData",
            location=req.location,
            camera=req.camera,
            data={"calendar": self._store.calendar(req.location, req.camera)},
        )
        try:
            conn.queue.put_nowait(snapshot)
        except asyncio.QueueFull:  # pragma: no cover - fresh queue
            pass

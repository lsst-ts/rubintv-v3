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
from lsst.ts.rubintv.data.controls import ControlStore, DetectorStore
from lsst.ts.rubintv.data.events import StoreChange
from lsst.ts.rubintv.data.heartbeats import HeartbeatStore
from lsst.ts.rubintv.data.metadata import MetadataCache
from lsst.ts.rubintv.data.store import EventStore
from lsst.ts.rubintv.logging import get_logger
from lsst.ts.rubintv.ws.manager import Connection, ConnectionManager
from lsst.ts.rubintv.ws.protocol import ServerMessage, SubscribeRequest
from pydantic import ValidationError

log = get_logger(__name__)

# Map a StoreChange.type to the topic kind that cares about it.
_CHANGE_TO_TOPIC = {
    "channelData": "camera",
    "metadata": "camera",
    "perDay": "camera",
    "nightReport": "nightReport",
    "dayChange": "camera",
    "calendarUpdate": "camera",
    "detectorStatus": "detectors",
    "controlReadback": "admin",
    "serviceStatus": "services",
}


class WsService:
    """Owns the connection manager and the bus pump task."""

    def __init__(
        self,
        store: EventStore,
        metadata: MetadataCache,
        controls: ControlStore,
        detectors: DetectorStore,
        heartbeats: HeartbeatStore,
    ) -> None:
        self._store = store
        self._metadata = metadata
        self._controls = controls
        self._detectors = detectors
        self._heartbeats = heartbeats
        self.manager = ConnectionManager()
        self._pump_task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._pump_task = asyncio.create_task(self._pump(), name="ws-bus-pump")

    async def stop(self) -> None:
        if self._pump_task is not None:
            self._pump_task.cancel()
            await asyncio.gather(self._pump_task, return_exceptions=True)

    async def _pump(self) -> None:
        """Translate bus changes into client messages.

        Each change is fanned out under its own guard: a malformed change (e.g.
        a StoreChange whose type has no ServerMessage counterpart) must degrade
        to a dropped message, never escape and kill the pump — a dead pump
        silently stops *all* live updates process-wide until restart.
        """
        async with self._store.bus.subscribe() as stream:
            async for change in stream:
                try:
                    self._fan_out(change)
                except Exception:  # noqa: BLE001 - one bad change must not kill the pump
                    log.exception("ws.pump.fan_out.error", change_type=change.type)

    def _fan_out(self, change: StoreChange) -> None:
        topic_kind = _CHANGE_TO_TOPIC.get(change.type)
        if topic_kind is None:
            return
        # Site-wide topics (detectors, admin) key off the kind alone — their
        # changes carry an empty location/camera, matching the client's
        # subscription key. Their payload travels with the message so a
        # subscriber updates without a follow-up fetch.
        if topic_kind in ("detectors", "admin", "services"):
            topic_key = "|".join([topic_kind, "", "", ""])
            msg = ServerMessage(type=change.type, data=self._site_payload(change.type))
            self.manager.publish_to_topic(topic_key, msg)
            return
        topic_key = "|".join([topic_kind, change.location, change.camera or "", ""])
        msg = ServerMessage(
            type=change.type,
            location=change.location,
            camera=change.camera,
            date=change.date,
        )
        self.manager.publish_to_topic(topic_key, msg)

    def _site_payload(self, change_type: str) -> dict[str, object]:
        """The current site-wide snapshot for a detectors/admin message."""
        if change_type == "detectorStatus":
            return {"detectors": self._detectors.all()}
        if change_type == "serviceStatus":
            return {"services": self._heartbeats.all()}
        return {"controls": self._controls.all("*")}

    # -- per-connection handling ----------------------------------------

    async def handle(self, socket: WebSocket) -> None:
        conn = await self.manager.connect(socket)
        sender = asyncio.create_task(self._send_loop(conn))
        streams: dict[str, asyncio.Task[None]] = {}
        try:
            await self._recv_loop(conn, streams)
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            stream_tasks = list(streams.values())
            for task in stream_tasks:
                task.cancel()
            await asyncio.gather(sender, *stream_tasks, return_exceptions=True)
            self.manager.disconnect(conn)

    async def _recv_loop(
        self, conn: Connection, streams: dict[str, asyncio.Task[None]]
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
            log.debug(
                "ws.frame.recv",
                conn=conn.id,
                action=req.action,
                topic=req.topic,
                location=req.location,
                camera=req.camera,
                date=req.date,
            )
            if req.action == "subscribe":
                self.manager.subscribe(conn, req.topic_key())
                self._send_snapshot(conn, req)
                if req.topic == "camera" and req.camera and req.date:
                    log.debug(
                        "ws.metadata.stream.start",
                        conn=conn.id,
                        camera=req.camera,
                        date=req.date,
                    )
                    self._start_metadata_stream(conn, req, streams)
                elif req.topic == "camera" and req.camera and not req.date:
                    log.debug(
                        "ws.metadata.stream.skip",
                        conn=conn.id,
                        reason="no_date_on_subscribe",
                        camera=req.camera,
                    )
            else:
                self.manager.unsubscribe(conn, req.topic_key())
                # A leaving subscriber's in-flight metadata stream would
                # otherwise run its whole (possibly minutes-long) transfer
                # for nobody, holding an executor slot the whole time.
                self._cancel_stream(streams, req.topic_key())

    def _start_metadata_stream(
        self,
        conn: Connection,
        req: SubscribeRequest,
        streams: dict[str, asyncio.Task[None]],
    ) -> None:
        """Launch a background task streaming a date's metadata to one client.

        One stream per topic key per connection: a re-subscribe (the client
        flipped to another date) supersedes the previous stream, so flipping
        through dates can't pile up transfers.
        """
        key = req.topic_key()
        self._cancel_stream(streams, key)
        task = asyncio.create_task(
            self._stream_metadata(conn, req.location, req.camera or "", req.date or "")
        )
        streams[key] = task

        def _cleanup(t: asyncio.Task[None]) -> None:
            if streams.get(key) is t:
                del streams[key]

        task.add_done_callback(_cleanup)

    @staticmethod
    def _cancel_stream(streams: dict[str, asyncio.Task[None]], key: str) -> None:
        task = streams.pop(key, None)
        if task is not None:
            task.cancel()

    async def _stream_metadata(
        self, conn: Connection, location: str, camera: str, date: str
    ) -> None:
        """Stream a date's metadata to one client as it parses off S3.

        Consumes ``MetadataCache.stream`` so the table fills progressively on
        slow links rather than after the whole transfer. The total chunk count
        isn't known until the end (it's a stream), so chunks carry a running
        row count and the final ``metadataComplete`` carries the totals + etag.
        A dropped chunk for a slow client is tolerated — the REST date payload
        remains the authoritative metadata source.
        """
        seq = 0
        rows_sent = 0
        try:
            async for batch in self._metadata.stream(location, camera, date):
                if not batch.done:
                    rows_sent += len(batch.rows)
                    self.manager.send_to(
                        conn,
                        ServerMessage(
                            type="metadataChunk",
                            location=location,
                            camera=camera,
                            date=date,
                            seq=seq,
                            data=batch.rows,
                        ),
                    )
                    log.debug(
                        "ws.metadata.chunk.enqueued",
                        conn=conn.id,
                        camera=camera,
                        date=date,
                        seq=seq,
                        rows_in_chunk=len(batch.rows),
                        rows_sent=rows_sent,
                    )
                    seq += 1
                    # Yield so a slow stream doesn't hold the loop between
                    # batches and other connections stay responsive.
                    await asyncio.sleep(0)
                else:
                    self.manager.send_to(
                        conn,
                        ServerMessage(
                            type="metadataComplete",
                            location=location,
                            camera=camera,
                            date=date,
                            seq=seq,
                            total=seq,
                            etag=batch.etag,
                        ),
                    )
                    log.debug(
                        "ws.metadata.complete",
                        conn=conn.id,
                        camera=camera,
                        date=date,
                        chunks=seq,
                        rows=rows_sent,
                    )
        except Exception:  # noqa: BLE001 - never let one stream kill the socket
            log.exception("ws.metadata.stream.error", camera=camera, date=date)

    async def _send_loop(self, conn: Connection) -> None:
        while True:
            msg = await conn.queue.get()
            await conn.socket.send_text(msg.model_dump_json())
            if msg.type in ("metadataChunk", "metadataComplete"):
                log.debug(
                    "ws.frame.sent",
                    conn=conn.id,
                    type=msg.type,
                    camera=msg.camera,
                    date=msg.date,
                    seq=msg.seq,
                    total=msg.total,
                )

    def _send_snapshot(self, conn: Connection, req: SubscribeRequest) -> None:
        """Push the current state for a freshly subscribed topic.

        Camera topics answer from the EventStore; the site-wide detectors and
        admin topics answer from their Redis-fed stores so a freshly opened
        tab is correct without waiting for the next change.
        """
        if req.topic == "detectors":
            self._queue(
                conn,
                ServerMessage(
                    type="detectorStatus",
                    data={"detectors": self._detectors.all()},
                ),
            )
            return
        if req.topic == "admin":
            self._queue(
                conn,
                ServerMessage(
                    type="controlReadback",
                    data={"controls": self._controls.all("*")},
                ),
            )
            return
        if req.topic == "services":
            self._queue(
                conn,
                ServerMessage(
                    type="serviceStatus",
                    data={"services": self._heartbeats.all()},
                ),
            )
            return
        if req.topic != "camera" or req.camera is None:
            # Channel snapshots are added with their data sources; camera is
            # the one the store can answer directly.
            return
        self._queue(
            conn,
            ServerMessage(
                type="channelData",
                location=req.location,
                camera=req.camera,
                data={"calendar": self._store.calendar(req.location, req.camera)},
            ),
        )

    @staticmethod
    def _queue(conn: Connection, msg: ServerMessage) -> None:
        try:
            conn.queue.put_nowait(msg)
        except asyncio.QueueFull:  # pragma: no cover - fresh queue
            pass

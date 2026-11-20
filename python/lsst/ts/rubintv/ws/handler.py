# This file is part of rubintv-v3.
#
# Developed for the Vera C. Rubin Observatory Telescope and Site Systems.
# This product includes software developed by the LSST Project
# (https://www.lsst.org).
# See the COPYRIGHT file at the top-level directory of this distribution
# for details of code ownership.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""The /ws endpoint and the bus pump.

The pump subscribes to the EventBus and, for each ``StoreChange``, computes
the affected topic key(s) and fans a typed ``ServerMessage`` to subscribers
via the ConnectionManager. The endpoint handles one client: accept, read
subscribe/unsubscribe frames, and drain its send queue concurrently.

On (re)subscribe to a camera/nightReport topic, the server immediately sends
the current snapshot for that topic so a freshly opened tab is correct
without waiting for the next change.

Messages for a camera are hints, not data: they name what changed (a date's
channel data, its metadata.json) and the client fetches it over REST.

A connection with nothing to carry is sent a heartbeat every
``HEARTBEAT_SECONDS``, so a page that hears nothing knows its socket is dead.
"""

from __future__ import annotations

import asyncio

from fastapi import WebSocket, WebSocketDisconnect
from lsst.ts.rubintv.data.controls import ControlStore, DetectorStore
from lsst.ts.rubintv.data.events import StoreChange
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
}

# How long a connection may carry nothing before the server sends a heartbeat
# frame. A page cannot see the protocol's own pings, so without this a socket
# that died without closing looks the same as a quiet night; the page
# reconnects once it has heard nothing for a little over two of these.
HEARTBEAT_SECONDS = 20.0


class WsService:
    """Owns the connection manager and the bus pump task."""

    def __init__(
        self,
        store: EventStore,
        controls: ControlStore,
        detectors: DetectorStore,
    ) -> None:
        self._store = store
        self._controls = controls
        self._detectors = detectors
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
                # One bad change must not kill the pump.
                except Exception:  # noqa: BLE001
                    log.exception("ws.pump.fan_out.error", change_type=change.type)

    def _fan_out(self, change: StoreChange) -> None:
        topic_kind = _CHANGE_TO_TOPIC.get(change.type)
        if topic_kind is None:
            return
        # Site-wide topics (detectors, admin) key off the kind alone — their
        # changes carry an empty location/camera, matching the client's
        # subscription key. Their payload travels with the message so a
        # subscriber updates without a follow-up fetch.
        if topic_kind in ("detectors", "admin"):
            topic_key = "|".join([topic_kind, "", ""])
            msg = ServerMessage(type=change.type, data=self._site_payload(change.type))
            self.manager.publish_to_topic(topic_key, msg)
            return
        topic_key = "|".join([topic_kind, change.location, change.camera or ""])
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
        return {"controls": self._controls.all("*")}

    # -- per-connection handling ----------------------------------------

    async def handle(self, socket: WebSocket) -> None:
        conn = await self.manager.connect(socket)
        sender = asyncio.create_task(self._send_loop(conn))
        try:
            await self._recv_loop(conn)
        except WebSocketDisconnect:
            pass
        finally:
            # Deregister before any await: if this task is being cancelled
            # (server shutdown, or a test client's close) every await below
            # re-raises, and a disconnect that followed them would be skipped
            # — leaving a dead connection in the registry and no
            # ws.disconnect log line.
            self.manager.disconnect(conn)
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)

    async def _recv_loop(self, conn: Connection) -> None:
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
            )
            if req.action == "subscribe":
                self.manager.subscribe(conn, req.topic_key())
                self._send_snapshot(conn, req)
            else:
                self.manager.unsubscribe(conn, req.topic_key())

    async def _send_loop(self, conn: Connection) -> None:
        while True:
            try:
                msg = await asyncio.wait_for(conn.queue.get(), HEARTBEAT_SECONDS)
            except TimeoutError:
                msg = ServerMessage(type="heartbeat")
            payload = msg.model_dump_json()
            await conn.socket.send_text(payload)
            size = len(payload.encode())
            conn.frames_sent += 1
            conn.bytes_sent += size
            log.debug(
                "ws.frame.sent",
                conn=conn.id,
                type=msg.type,
                bytes=size,
                camera=msg.camera,
                date=msg.date,
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
        if req.topic != "camera" or req.camera is None:
            # nightReport has no snapshot: its view loads over REST and the
            # topic only signals when to refetch.
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

"""The pod-local heartbeat endpoint for Rapid Analysis services.

RA service processes in the same k8s pod report liveness here, either by
holding a WebSocket and beating periodically, or with a fire-and-forget POST.
Both feed the same ``HeartbeatStore``. A beat that revives a stale service,
and the reaper noticing a service lapse, each publish a ``serviceStatus``
change so subscribed browsers update live (via the existing ``/ws`` fan-out).

This is intentionally minimal: TTL-only liveness, no explicit-offline frame.
"""

from __future__ import annotations

import asyncio

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, ValidationError

from rubintv.data.bus import EventBus
from rubintv.data.events import StoreChange
from rubintv.data.heartbeats import HeartbeatStore
from rubintv.logging import get_logger

log = get_logger(__name__)

# How often the reaper checks for lapsed services. Liveness itself is computed
# on read, so this only bounds how quickly a live→stale transition is *pushed*.
_REAP_INTERVAL_SECONDS = 5.0


class Heartbeat(BaseModel):
    """One liveness report from an RA service."""

    service: str
    ttl: float = Field(default=30.0, gt=0)
    """Seconds this service stays live without a further beat."""
    location: str | None = None


class HeartbeatService:
    """Owns the heartbeat store and the stale-reaper task."""

    def __init__(self, bus: EventBus, store: HeartbeatStore) -> None:
        self._bus = bus
        self._store = store
        self._reaper: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._reaper = asyncio.create_task(self._reap_loop(), name="heartbeat-reaper")

    async def stop(self) -> None:
        if self._reaper is not None:
            self._reaper.cancel()
            await asyncio.gather(self._reaper, return_exceptions=True)

    def record(self, beat: Heartbeat) -> None:
        """Apply a beat and publish a change if it revived a stale service."""
        revived = self._store.beat(beat.service, beat.ttl, beat.location)
        log.debug("heartbeat.beat", service=beat.service, ttl=beat.ttl)
        if revived:
            self._publish(beat.location)

    def _publish(self, location: str | None) -> None:
        self._bus.publish(StoreChange("serviceStatus", location or "*", ""))

    async def _reap_loop(self) -> None:
        """Publish a change whenever a service lapses from live to stale."""
        while True:
            await asyncio.sleep(_REAP_INTERVAL_SECONDS)
            for service in self._store.newly_stale():
                log.info("heartbeat.stale", service=service)
                self._publish(None)

    async def handle(self, socket: WebSocket) -> None:
        """One RA service socket: accept and apply each beat frame it sends."""
        await socket.accept()
        log.info("heartbeat.connect")
        try:
            while True:
                raw = await socket.receive_text()
                try:
                    beat = Heartbeat.model_validate_json(raw)
                except ValidationError as exc:
                    await socket.send_text(f'{{"error": {exc.json()}}}')
                    continue
                self.record(beat)
        except WebSocketDisconnect:
            log.info("heartbeat.disconnect")

"""Redis-sourced live inputs (detector status + control readback).

Redis is just another source feeding the same EventBus — the WS handler
doesn't know or care that a change came from Redis rather than S3. Redis is
*optional*: with no configured URL (or an unreachable server) these inputs
are disabled with a clear warning, but the rest of the app serves S3 data
normally (fixing the old silent degradation).

This wires the control readback into the shared ControlStore and publishes
detector/readback changes as StoreChanges. Full stream-key parsing matches
the deployment's ``redis_detectors`` config; here we provide the connection
lifecycle and the publish path.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from rubintv.data.controls import ControlStore
from rubintv.data.events import StoreChange
from rubintv.logging import get_logger

if TYPE_CHECKING:
    from redis.asyncio import Redis

    from rubintv.data.bus import EventBus

log = get_logger(__name__)


class RedisInputs:
    """Manages the optional Redis connection and its background readers."""

    def __init__(
        self,
        redis_url: str | None,
        bus: EventBus,
        controls: ControlStore,
    ) -> None:
        self._url = redis_url
        self._bus = bus
        self._controls = controls
        self._redis: Redis | None = None
        self._tasks: list[asyncio.Task[None]] = []

    @property
    def enabled(self) -> bool:
        return self._redis is not None

    async def start(self) -> None:
        """Connect and launch readers. No-op (warns) if disabled/unreachable."""
        if not self._url:
            log.warning("redis.disabled", reason="no RUBINTV_REDIS_URL configured")
            return
        try:
            from redis.asyncio import Redis

            self._redis = Redis.from_url(self._url, decode_responses=True)
            await self._redis.ping()  # type: ignore[misc]
        except Exception as exc:  # noqa: BLE001 - degrade, don't crash
            log.warning("redis.unavailable", error=str(exc))
            self._redis = None
            return
        log.info("redis.connected", url=self._url)
        self._tasks.append(
            asyncio.create_task(self._readback_loop(), name="redis-readback")
        )

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._redis is not None:
            await self._redis.aclose()

    async def _readback_loop(self) -> None:
        """Subscribe to keyspace events for *_READBACK keys and republish.

        Keyspace notifications must be enabled on the server
        (``notify-keyspace-events KEA`` or similar). When a readback key
        changes, fetch its value, update the ControlStore, and publish a
        controlReadback StoreChange.
        """
        assert self._redis is not None
        pubsub = self._redis.pubsub()
        # Pattern covers keyspace notifications for any *_READBACK key.
        await pubsub.psubscribe("__keyspace@0__:*_READBACK")
        async for message in pubsub.listen():
            if message.get("type") != "pmessage":
                continue
            channel = str(message["channel"])
            key = channel.split(":", 1)[-1]
            value = await self._redis.get(key)
            if value is None:
                continue
            # Location is encoded in deployment config; readback is global to
            # the site here, so publish without a camera scope.
            self._controls.set("*", key, str(value))
            self._bus.publish(StoreChange("metadata", "*", ""))

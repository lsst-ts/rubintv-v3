"""In-process pub/sub for store changes.

The ``EventStore`` publishes ``StoreChange``s here; subscribers (the
WebSocket handler in Phase 4, cache-invalidation hints) react. This is the
seam that keeps the data path from knowing a WebSocket exists.

Delivery is best-effort and isolated: a slow or failing subscriber must not
block the publisher or other subscribers, so each subscriber owns a bounded
queue and is fed via its own task.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from lsst.ts.rubintv.data.events import StoreChange
from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)

_QUEUE_MAXSIZE = 1000


class EventBus:
    """Fan-out of ``StoreChange`` to any number of subscribers."""

    def __init__(self) -> None:
        self._queues: set[asyncio.Queue[StoreChange]] = set()

    def publish(self, change: StoreChange) -> None:
        """Publish a change to all subscribers (non-blocking).

        If a subscriber's queue is full it is dropped for that subscriber
        (logged), rather than stalling the publisher — backpressure is the
        subscriber's problem to keep up with.
        """
        for queue in self._queues:
            try:
                queue.put_nowait(change)
            except asyncio.QueueFull:
                log.warning("bus.subscriber.slow", change_type=change.type)

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[AsyncIterator[StoreChange]]:
        """Async context manager yielding a stream of changes.

        Usage::

            async with bus.subscribe() as stream:
                async for change in stream:
                    ...
        """
        queue: asyncio.Queue[StoreChange] = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
        self._queues.add(queue)
        try:
            yield self._drain(queue)
        finally:
            self._queues.discard(queue)

    async def _drain(
        self, queue: asyncio.Queue[StoreChange]
    ) -> AsyncIterator[StoreChange]:
        while True:
            yield await queue.get()

    @property
    def subscriber_count(self) -> int:
        return len(self._queues)

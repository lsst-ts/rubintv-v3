"""WebSocket relay between DDV browser clients and its worker pods.

The DDV (Derived Data Visualization) Flutter app doesn't talk to this
service's data model; it sends opaque job messages that are executed by
separate worker pods (``rubintv_visualization`` backends) running in the
cluster. This module is the switchboard between the two:

- Browsers connect on the public client endpoint and send one message per
  job.
- Worker pods connect on the internal worker endpoint and wait for work.
- A job goes to any idle worker; if none is idle it queues. A worker's next
  message is treated as the completion of its current job and is relayed
  back to the originating client, after which the worker picks up queued
  work.

The relay is deliberately protocol-agnostic: messages are opaque text
frames, one request and one response per job (matching the v2 contract the
DDV client and workers already speak).
"""

from __future__ import annotations

import uuid
from collections import deque
from dataclasses import dataclass

from fastapi import WebSocket, WebSocketDisconnect

from rubintv.logging import get_logger

log = get_logger(__name__)

# Workers send this sentinel instead of a result when their client vanished
# mid-job (part of the v2 wire contract); it frees the worker but is never
# relayed.
_CLIENT_GONE = "Client disconnected"


@dataclass
class _Client:
    """One connected browser (DDV frontend)."""

    conn_id: str
    socket: WebSocket


@dataclass
class _Worker:
    """One connected worker pod and the client it is currently serving."""

    conn_id: str
    socket: WebSocket
    client: _Client | None = None
    """The client whose job this worker is running; ``None`` when idle."""


@dataclass
class _Job:
    message: str
    client: _Client


class DdvBridge:
    """Relay jobs from DDV clients to worker pods and results back.

    All mutation happens on the event loop between ``await`` points, so no
    locking is needed; the queue and registries are plain containers.
    """

    def __init__(self) -> None:
        self._clients: dict[str, _Client] = {}
        self._workers: dict[str, _Worker] = {}
        self._queue: deque[_Job] = deque()

    async def handle_client(self, socket: WebSocket) -> None:
        """Serve one browser connection for its lifetime."""
        await socket.accept()
        client = _Client(str(uuid.uuid4()), socket)
        self._clients[client.conn_id] = client
        log.info("ddv.client.connected", client_id=client.conn_id)
        try:
            while True:
                message = await socket.receive_text()
                await self._dispatch(message, client)
        except WebSocketDisconnect:
            self._drop_client(client)

    async def handle_worker(self, socket: WebSocket) -> None:
        """Serve one worker-pod connection for its lifetime."""
        await socket.accept()
        worker = _Worker(str(uuid.uuid4()), socket)
        self._workers[worker.conn_id] = worker
        log.info("ddv.worker.connected", worker_id=worker.conn_id)
        # A fresh worker can immediately take queued work (v2 left queued
        # jobs waiting until some *other* job finished).
        await self._assign_next(worker)
        try:
            while True:
                message = await socket.receive_text()
                await self._finish(worker, message)
        except WebSocketDisconnect:
            self._drop_worker(worker)

    async def _dispatch(self, message: str, client: _Client) -> None:
        """Send a client's job to an idle worker, or queue it."""
        idle = next((w for w in self._workers.values() if w.client is None), None)
        if idle is None:
            self._queue.append(_Job(message, client))
            log.info("ddv.job.queued", client_id=client.conn_id, depth=len(self._queue))
            return
        await self._start_job(idle, _Job(message, client))

    async def _start_job(self, worker: _Worker, job: _Job) -> None:
        worker.client = job.client
        log.info(
            "ddv.job.started",
            worker_id=worker.conn_id,
            client_id=job.client.conn_id,
        )
        try:
            await worker.socket.send_text(job.message)
        except Exception:  # send failed: worker is gone; don't lose the job
            log.warning("ddv.worker.send_failed", worker_id=worker.conn_id)
            self._drop_worker(worker)
            await self._dispatch(job.message, job.client)

    async def _finish(self, worker: _Worker, message: str) -> None:
        """Relay a worker's result to its client and hand it queued work."""
        client, worker.client = worker.client, None
        if client is None or message == _CLIENT_GONE:
            log.info(
                "ddv.job.unclaimed", worker_id=worker.conn_id, has_client=bool(client)
            )
        else:
            try:
                await client.socket.send_text(message)
            except Exception:  # client left before the result arrived
                log.info("ddv.client.send_failed", client_id=client.conn_id)
        await self._assign_next(worker)

    async def _assign_next(self, worker: _Worker) -> None:
        if self._queue:
            await self._start_job(worker, self._queue.popleft())

    def _drop_client(self, client: _Client) -> None:
        self._clients.pop(client.conn_id, None)
        # Abandon its queued jobs and detach any worker still running one, so
        # results aren't sent into a closed socket.
        self._queue = deque(j for j in self._queue if j.client is not client)
        for worker in self._workers.values():
            if worker.client is client:
                worker.client = None
        log.info("ddv.client.disconnected", client_id=client.conn_id)

    def _drop_worker(self, worker: _Worker) -> None:
        self._workers.pop(worker.conn_id, None)
        if worker.client is not None:
            # The in-flight job is lost (its message isn't retained); the
            # client will retry at the protocol level.
            log.warning(
                "ddv.worker.lost_job",
                worker_id=worker.conn_id,
                client_id=worker.client.conn_id,
            )
        log.info("ddv.worker.disconnected", worker_id=worker.conn_id)

"""The DDV client/worker WebSocket relay."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import boto3
import pytest
from fastapi import WebSocketDisconnect
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
from lsst.ts.rubintv.ws import ddv as ddv_mod
from moto import mock_aws

from tests.conftest import CONFIG_PATH, TEST_BUCKET, PrefixedTestClient

CLIENT_WS = "/ws/ddv/client"
WORKER_WS = "/internal/ddv/worker"


@contextmanager
def run_app() -> Iterator[PrefixedTestClient]:
    # cache_dir=None: tests must never touch the real /scratch default.
    settings = Settings(
        models_path=CONFIG_PATH,
        site="test",
        poll_interval_seconds=0.05,
        cache_dir=None,
    )
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=TEST_BUCKET)
        with PrefixedTestClient(create_app(settings)) as client:
            yield client


def test_job_relayed_to_worker_and_result_back() -> None:
    with run_app() as app:
        with (
            app.websocket_connect(WORKER_WS) as worker,
            app.websocket_connect(CLIENT_WS) as client,
        ):
            client.send_text("do-work")
            assert worker.receive_text() == "do-work"
            worker.send_text("result")
            assert client.receive_text() == "result"


def test_job_queued_until_a_worker_connects() -> None:
    with run_app() as app:
        with app.websocket_connect(CLIENT_WS) as client:
            client.send_text("queued-job")
            # No worker yet; the job waits. A connecting worker picks it up.
            with app.websocket_connect(WORKER_WS) as worker:
                assert worker.receive_text() == "queued-job"
                worker.send_text("late-result")
                assert client.receive_text() == "late-result"


def test_busy_worker_queues_second_job() -> None:
    with run_app() as app:
        with (
            app.websocket_connect(WORKER_WS) as worker,
            app.websocket_connect(CLIENT_WS) as first,
            app.websocket_connect(CLIENT_WS) as second,
        ):
            first.send_text("job-1")
            assert worker.receive_text() == "job-1"
            # Worker is busy, so the second job queues until it finishes.
            second.send_text("job-2")
            worker.send_text("result-1")
            assert first.receive_text() == "result-1"
            assert worker.receive_text() == "job-2"
            worker.send_text("result-2")
            assert second.receive_text() == "result-2"


def test_jobs_spread_across_idle_workers() -> None:
    with run_app() as app:
        with (
            app.websocket_connect(WORKER_WS) as w1,
            app.websocket_connect(WORKER_WS) as w2,
            app.websocket_connect(CLIENT_WS) as client,
        ):
            client.send_text("job-1")
            client.send_text("job-2")
            # Both workers are idle, so each takes one job.
            got = {w1.receive_text(), w2.receive_text()}
            assert got == {"job-1", "job-2"}


def test_late_reply_for_departed_client_is_not_given_to_next_client() -> None:
    with run_app() as app:
        with app.websocket_connect(WORKER_WS) as worker:
            with app.websocket_connect(CLIENT_WS) as first:
                first.send_text("job-1")
                assert worker.receive_text() == "job-1"
            # `first` is gone while job-1 still runs on the worker. The worker
            # must stay busy: job-2 queues until job-1's (now unwanted) reply
            # arrives, and that reply must not be relayed to `second`.
            with app.websocket_connect(CLIENT_WS) as second:
                second.send_text("job-2")
                worker.send_text("result-1")
                assert worker.receive_text() == "job-2"
                worker.send_text("result-2")
                assert second.receive_text() == "result-2"


def test_client_gone_sentinel_is_not_relayed() -> None:
    with run_app() as app:
        with (
            app.websocket_connect(WORKER_WS) as worker,
            app.websocket_connect(CLIENT_WS) as client,
        ):
            client.send_text("job-1")
            assert worker.receive_text() == "job-1"
            # The worker reports the (v2 wire-contract) client-gone sentinel;
            # it must free the worker without echoing to the client.
            worker.send_text("Client disconnected")
            client.send_text("job-2")
            assert worker.receive_text() == "job-2"


# --- Unit tests on DdvBridge internals (fake sockets) -----------------------


class _FakeSocket:
    """Minimal WebSocket stand-in: records sent frames; feeds queued inbound
    frames then raises the configured error (default WebSocketDisconnect)."""

    def __init__(
        self, inbound: list[str] | None = None, error: Exception | None = None
    ):
        self.sent: list[str] = []
        self._inbound = list(inbound or [])
        self._error = error or WebSocketDisconnect()
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        if self._inbound:
            return self._inbound.pop(0)
        raise self._error

    async def send_text(self, text: str) -> None:
        self.sent.append(text)


async def test_dispatch_bounds_the_queue() -> None:
    # The public client endpoint must not let a flood of jobs (no idle worker)
    # grow the queue without bound. At the cap the oldest job is dropped.
    bridge = ddv_mod.DdvBridge()
    client = ddv_mod._Client("c", _FakeSocket())
    for i in range(ddv_mod._MAX_QUEUE_DEPTH + 5):
        await bridge._dispatch(f"job-{i}", client)
    assert len(bridge._queue) == ddv_mod._MAX_QUEUE_DEPTH
    # Oldest were dropped; newest retained.
    assert bridge._queue[-1].message == f"job-{ddv_mod._MAX_QUEUE_DEPTH + 4}"


async def test_handle_client_cleans_up_on_non_disconnect_error() -> None:
    # A binary frame makes Starlette's receive_text raise KeyError (not
    # WebSocketDisconnect). Cleanup must still run (finally) even though the
    # error then propagates, or the client leaks into the registry forever.
    bridge = ddv_mod.DdvBridge()
    sock = _FakeSocket(inbound=[], error=KeyError("bytes"))
    with pytest.raises(KeyError):
        await bridge.handle_client(sock)
    assert bridge._clients == {}


async def test_handle_worker_cleans_up_on_non_disconnect_error() -> None:
    bridge = ddv_mod.DdvBridge()
    sock = _FakeSocket(inbound=[], error=RuntimeError("teardown"))
    with pytest.raises(RuntimeError):
        await bridge.handle_worker(sock)
    assert bridge._workers == {}

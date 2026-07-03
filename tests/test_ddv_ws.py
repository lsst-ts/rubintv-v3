"""The DDV client/worker WebSocket relay."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import boto3
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
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

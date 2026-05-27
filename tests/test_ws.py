"""WebSocket protocol, manager, and end-to-end live delivery."""

from __future__ import annotations

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from rubintv.app import create_app
from rubintv.config.settings import Settings
from rubintv.ws.manager import Connection, ConnectionManager
from rubintv.ws.protocol import ServerMessage, SubscribeRequest
from tests.conftest import LOCAL_BUCKET

DATE = "2026-04-10"


def test_topic_key_stable() -> None:
    a = SubscribeRequest(
        action="subscribe", topic="camera", location="local", camera="lsstcam"
    )
    b = SubscribeRequest(
        action="unsubscribe", topic="camera", location="local", camera="lsstcam"
    )
    # Action doesn't affect identity; topic+loc+cam+chan does.
    assert a.topic_key() == b.topic_key()
    assert a.topic_key() == "camera|local|lsstcam|"


def test_manager_fanout_only_to_subscribers() -> None:
    mgr = ConnectionManager()
    # Two fake connections without real sockets; we only exercise queueing.
    c1 = Connection(id="1", socket=None)  # type: ignore[arg-type]
    c2 = Connection(id="2", socket=None)  # type: ignore[arg-type]
    mgr._connections.update({"1": c1, "2": c2})  # noqa: SLF001 - test setup
    mgr.subscribe(c1, "camera|local|lsstcam|")

    msg = ServerMessage(type="channelData", location="local", camera="lsstcam")
    mgr.publish_to_topic("camera|local|lsstcam|", msg)

    assert c1.queue.qsize() == 1
    assert c2.queue.qsize() == 0


def test_manager_unsubscribe_removes_topic_index() -> None:
    mgr = ConnectionManager()
    c1 = Connection(id="1", socket=None)  # type: ignore[arg-type]
    mgr._connections["1"] = c1  # noqa: SLF001
    mgr.subscribe(c1, "camera|local|lsstcam|")
    mgr.unsubscribe(c1, "camera|local|lsstcam|")
    msg = ServerMessage(type="channelData")
    mgr.publish_to_topic("camera|local|lsstcam|", msg)
    assert c1.queue.qsize() == 0


@pytest.fixture
def ws_client(settings: Settings):  # type: ignore[no-untyped-def]
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=LOCAL_BUCKET)
        app = create_app(settings)
        with TestClient(app) as client:
            yield client, s3


def test_ws_subscribe_gets_snapshot(ws_client) -> None:  # type: ignore[no-untyped-def]
    client, _ = ws_client
    with client.websocket_connect("/ws") as ws:
        ws.send_json(
            {
                "action": "subscribe",
                "topic": "camera",
                "location": "local",
                "camera": "lsstcam",
            }
        )
        # The server sends the current snapshot immediately on subscribe.
        msg = ws.receive_json()
        assert msg["type"] == "channelData"
        assert msg["camera"] == "lsstcam"


def test_ws_bad_frame_gets_error(ws_client) -> None:  # type: ignore[no-untyped-def]
    client, _ = ws_client
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe"})  # missing required fields
        msg = ws.receive_json()
        assert msg["type"] == "error"

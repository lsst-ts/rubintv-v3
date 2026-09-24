"""WebSocket protocol, manager, and end-to-end live delivery."""

from __future__ import annotations

import asyncio

import boto3
import pytest
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
from lsst.ts.rubintv.data.events import StoreChange
from lsst.ts.rubintv.ws.manager import Connection, ConnectionManager
from lsst.ts.rubintv.ws.protocol import ServerMessage, SubscribeRequest
from moto import mock_aws

from tests.conftest import TEST_BUCKET, PrefixedTestClient

DATE = "2026-04-10"


def test_topic_key_stable() -> None:
    a = SubscribeRequest(
        action="subscribe", topic="camera", location="test", camera="lsstcam"
    )
    b = SubscribeRequest(
        action="unsubscribe", topic="camera", location="test", camera="lsstcam"
    )
    # Action doesn't affect identity; topic+loc+cam+chan does.
    assert a.topic_key() == b.topic_key()
    assert a.topic_key() == "camera|test|lsstcam|"


def test_manager_fanout_only_to_subscribers() -> None:
    mgr = ConnectionManager()
    # Two fake connections without real sockets; we only exercise queueing.
    c1 = Connection(id="1", socket=None)  # type: ignore[arg-type]
    c2 = Connection(id="2", socket=None)  # type: ignore[arg-type]
    mgr._connections.update({"1": c1, "2": c2})  # noqa: SLF001 - test setup
    mgr.subscribe(c1, "camera|test|lsstcam|")

    msg = ServerMessage(type="channelData", location="test", camera="lsstcam")
    mgr.publish_to_topic("camera|test|lsstcam|", msg)

    assert c1.queue.qsize() == 1
    assert c2.queue.qsize() == 0


def test_manager_unsubscribe_removes_topic_index() -> None:
    mgr = ConnectionManager()
    c1 = Connection(id="1", socket=None)  # type: ignore[arg-type]
    mgr._connections["1"] = c1  # noqa: SLF001
    mgr.subscribe(c1, "camera|test|lsstcam|")
    mgr.unsubscribe(c1, "camera|test|lsstcam|")
    msg = ServerMessage(type="channelData")
    mgr.publish_to_topic("camera|test|lsstcam|", msg)
    assert c1.queue.qsize() == 0


def test_manager_disconnect_cleans_topic_index() -> None:
    # Dropping a connection removes it from every topic set, and empty topic
    # sets are deleted so the index doesn't accumulate dead keys.
    mgr = ConnectionManager()
    c1 = Connection(id="1", socket=None)  # type: ignore[arg-type]
    mgr._connections["1"] = c1  # noqa: SLF001
    mgr.subscribe(c1, "camera|test|lsstcam|")
    mgr.subscribe(c1, "detectors|||")
    assert mgr.connection_count == 1
    mgr.disconnect(c1)
    assert mgr.connection_count == 0
    assert mgr._by_topic == {}  # noqa: SLF001


def test_manager_publish_skips_stale_connection_ids() -> None:
    # A topic set referencing an id with no live connection is skipped, not an
    # error (disconnect raced with publish).
    mgr = ConnectionManager()
    mgr._by_topic["camera|test|lsstcam|"] = {"ghost"}  # noqa: SLF001
    mgr.publish_to_topic("camera|test|lsstcam|", ServerMessage(type="channelData"))


def test_manager_drops_message_for_slow_client() -> None:
    # A full send queue means the client can't keep up: the message is dropped
    # rather than blocking the publisher.
    mgr = ConnectionManager()
    c1 = Connection(
        id="1",
        socket=None,  # type: ignore[arg-type]
        queue=asyncio.Queue(maxsize=1),
    )
    mgr.send_to(c1, ServerMessage(type="channelData"))
    mgr.send_to(c1, ServerMessage(type="event"))  # dropped, no raise
    assert c1.queue.qsize() == 1
    assert c1.queue.get_nowait().type == "channelData"


@pytest.fixture
def ws_client(settings: Settings):  # type: ignore[no-untyped-def]
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=TEST_BUCKET)
        app = create_app(settings)
        with PrefixedTestClient(app) as client:
            yield client, s3


def test_ws_subscribe_gets_snapshot(ws_client) -> None:  # type: ignore[no-untyped-def]
    client, _ = ws_client
    with client.websocket_connect("/ws") as ws:
        ws.send_json(
            {
                "action": "subscribe",
                "topic": "camera",
                "location": "test",
                "camera": "lsstcam",
            }
        )
        # The server sends the current snapshot immediately on subscribe.
        msg = ws.receive_json()
        assert msg["type"] == "channelData"
        assert msg["camera"] == "lsstcam"


def test_ws_detectors_snapshot_and_delta(ws_client) -> None:  # type: ignore[no-untyped-def]
    client, _ = ws_client
    state = client.app.state.app_state
    # Seed a status so the subscribe snapshot is non-empty.
    state.detectors.set("sfmSet0", {"workers": {"0": {"status": "busy"}}})
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe", "topic": "detectors", "location": ""})
        snap = ws.receive_json()
        assert snap["type"] == "detectorStatus"
        assert snap["data"]["detectors"]["sfmSet0"] == {
            "workers": {"0": {"status": "busy"}}
        }

        # A bus change fans out the current site-wide snapshot to subscribers.
        state.detectors.set(
            "sfmSet0",
            {"workers": {"0": {"status": "free"}, "1": {"status": "busy"}}},
        )
        state.store.bus.publish(StoreChange("detectorStatus", "*", ""))
        delta = ws.receive_json()
        assert delta["type"] == "detectorStatus"
        assert delta["data"]["detectors"]["sfmSet0"]["workers"]["1"] == {
            "status": "busy"
        }


def test_ws_admin_snapshot(ws_client) -> None:  # type: ignore[no-untyped-def]
    client, _ = ws_client
    state = client.app.state.app_state
    state.controls.set("*", "AOS_READBACK", "danish")
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe", "topic": "admin", "location": ""})
        snap = ws.receive_json()
        assert snap["type"] == "controlReadback"
        assert snap["data"]["controls"] == {"AOS_READBACK": "danish"}


def test_ws_calendar_update_delivered_and_pump_survives(ws_client) -> None:  # type: ignore[no-untyped-def]
    # Regression: prune_dates publishes StoreChange("calendarUpdate", ...). The
    # type must exist in ServerMessageType (a "calendar"/"calendarUpdate"
    # mismatch made _fan_out raise ValidationError, which killed the bus pump
    # and silently stopped ALL live updates process-wide). Assert the change is
    # delivered AND a following change still arrives (the pump did not die).
    client, _ = ws_client
    state = client.app.state.app_state
    with client.websocket_connect("/ws") as ws:
        ws.send_json(
            {
                "action": "subscribe",
                "topic": "camera",
                "location": "test",
                "camera": "lsstcam",
            }
        )
        assert ws.receive_json()["type"] == "channelData"  # subscribe snapshot

        state.store.bus.publish(StoreChange("calendarUpdate", "test", "lsstcam", DATE))
        upd = ws.receive_json()
        assert upd["type"] == "calendarUpdate"
        assert upd["camera"] == "lsstcam"
        assert upd["date"] == DATE

        # The pump is still alive: a subsequent change is delivered.
        state.store.bus.publish(StoreChange("dayChange", "test", "lsstcam", DATE))
        assert ws.receive_json()["type"] == "dayChange"


def test_ws_bad_frame_gets_error(ws_client) -> None:  # type: ignore[no-untyped-def]
    client, _ = ws_client
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe"})  # missing required fields
        msg = ws.receive_json()
        assert msg["type"] == "error"


def test_ws_streams_metadata_in_chunks(ws_client, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import json

    from lsst.ts.rubintv.data import metadata as metadata_mod

    client, s3 = ws_client
    # 3 rows with a batch size of 2 -> two metadataChunk frames + complete.
    rows = {str(n): {"exp_time": n} for n in range(1, 4)}
    s3.put_object(
        Bucket=TEST_BUCKET,
        Key=f"lsstcam/{DATE}/metadata.json",
        Body=json.dumps(rows).encode(),
    )

    monkeypatch.setattr(metadata_mod, "_STREAM_BATCH_ROWS", 2)
    with client.websocket_connect("/ws") as ws:
        ws.send_json(
            {
                "action": "subscribe",
                "topic": "camera",
                "location": "test",
                "camera": "lsstcam",
                "date": DATE,
            }
        )
        # First frame is the camera snapshot (channelData); then metadata.
        assert ws.receive_json()["type"] == "channelData"
        received: dict[str, dict[str, object]] = {}
        chunks = 0
        while True:
            msg = ws.receive_json()
            if msg["type"] == "metadataComplete":
                # Streamed total == number of chunks sent (2 for 3 rows @ 2).
                assert msg["total"] == chunks == 2
                break
            assert msg["type"] == "metadataChunk"
            chunks += 1
            received.update(msg["data"])
        assert received == rows

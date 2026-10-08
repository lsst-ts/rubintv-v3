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

"""WebSocket protocol, manager, and end-to-end live delivery."""

from __future__ import annotations

import asyncio

import boto3
import pytest
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
from lsst.ts.rubintv.data.events import StoreChange
from lsst.ts.rubintv.ws.handler import WsService
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
    assert a.topic_key() == "camera|test|lsstcam"


def test_manager_fanout_only_to_subscribers() -> None:
    mgr = ConnectionManager()
    # Two fake connections without real sockets; we only exercise queueing.
    c1 = Connection(id="1", socket=None)  # type: ignore[arg-type]
    c2 = Connection(id="2", socket=None)  # type: ignore[arg-type]
    mgr._connections.update({"1": c1, "2": c2})  # noqa: SLF001 - test setup
    mgr.subscribe(c1, "camera|test|lsstcam")

    msg = ServerMessage(type="channelData", location="test", camera="lsstcam")
    mgr.publish_to_topic("camera|test|lsstcam", msg)

    assert c1.queue.qsize() == 1
    assert c2.queue.qsize() == 0


def test_manager_unsubscribe_removes_topic_index() -> None:
    mgr = ConnectionManager()
    c1 = Connection(id="1", socket=None)  # type: ignore[arg-type]
    mgr._connections["1"] = c1  # noqa: SLF001
    mgr.subscribe(c1, "camera|test|lsstcam")
    mgr.unsubscribe(c1, "camera|test|lsstcam")
    msg = ServerMessage(type="channelData")
    mgr.publish_to_topic("camera|test|lsstcam", msg)
    assert c1.queue.qsize() == 0


def test_manager_disconnect_cleans_topic_index() -> None:
    # Dropping a connection removes it from every topic set, and empty topic
    # sets are deleted so the index doesn't accumulate dead keys.
    mgr = ConnectionManager()
    c1 = Connection(id="1", socket=None)  # type: ignore[arg-type]
    mgr._connections["1"] = c1  # noqa: SLF001
    mgr.subscribe(c1, "camera|test|lsstcam")
    mgr.subscribe(c1, "detectors||")
    assert mgr.connection_count == 1
    mgr.disconnect(c1)
    assert mgr.connection_count == 0
    assert mgr._by_topic == {}  # noqa: SLF001


def test_manager_publish_skips_stale_connection_ids() -> None:
    # A topic set referencing an id with no live connection is skipped, not an
    # error (disconnect raced with publish).
    mgr = ConnectionManager()
    mgr._by_topic["camera|test|lsstcam"] = {"ghost"}  # noqa: SLF001
    mgr.publish_to_topic("camera|test|lsstcam", ServerMessage(type="channelData"))


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
    mgr.send_to(c1, ServerMessage(type="perDay"))  # dropped, no raise
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


async def test_send_loop_counts_frames_and_bytes() -> None:
    # The send loop records what it put on the wire so ws.disconnect can
    # report a connection's total cost.
    sent: list[str] = []

    class FakeSocket:
        async def send_text(self, text: str) -> None:
            sent.append(text)

    conn = Connection(id="1", socket=FakeSocket())  # type: ignore[arg-type]
    svc = WsService.__new__(WsService)  # _send_loop touches no service state
    task = asyncio.create_task(svc._send_loop(conn))
    conn.queue.put_nowait(ServerMessage(type="channelData", camera="lsstcam"))
    conn.queue.put_nowait(ServerMessage(type="perDay", data={"k": "v"}))
    await asyncio.sleep(0.01)
    task.cancel()
    assert conn.frames_sent == 2
    assert conn.bytes_sent == sum(len(t.encode()) for t in sent)
    assert conn.bytes_sent > 0


def test_connection_deregistered_when_handler_is_cancelled() -> None:
    # The test client cancels the handler task on close (as a server shutdown
    # would), rather than delivering WebSocketDisconnect. Deregistration must
    # not sit behind an await in that path, or the registry keeps a dead
    # connection and ws.disconnect is never logged.
    import boto3
    from lsst.ts.rubintv.app import create_app
    from lsst.ts.rubintv.config.settings import Settings
    from moto import mock_aws

    from tests.conftest import CONFIG_PATH, TEST_BUCKET, PrefixedTestClient

    settings = Settings(
        models_path=CONFIG_PATH,
        site="test",
        cache_dir=None,
        poll_interval_seconds=0.5,
    )
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=TEST_BUCKET)
        app = create_app(settings)
        with PrefixedTestClient(app) as client:
            manager = app.state.app_state.ws.manager
            with client.websocket_connect("/ws") as ws:
                ws.send_json(
                    {
                        "action": "subscribe",
                        "topic": "camera",
                        "location": "test",
                        "camera": "lsstcam",
                    }
                )
                ws.receive_json()
                assert manager.connection_count == 1
            assert manager.connection_count == 0


def test_ws_refresh_restreams(ws_client, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import json

    from lsst.ts.rubintv.data import metadata as metadata_mod

    client, s3 = ws_client
    rows = {str(n): {"exp_time": n} for n in range(1, 4)}
    s3.put_object(
        Bucket=TEST_BUCKET,
        Key=f"lsstcam/{DATE}/metadata.json",
        Body=json.dumps(rows).encode(),
    )
    monkeypatch.setattr(metadata_mod, "_STREAM_BATCH_ROWS", 2)
    sub = {"topic": "camera", "location": "test", "camera": "lsstcam", "date": DATE}

    def drain_stream(ws) -> list[str]:  # type: ignore[no-untyped-def]
        types: list[str] = []
        while True:
            msg = ws.receive_json()
            types.append(msg["type"])
            if msg["type"] == "metadataComplete":
                return types

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe", **sub})
        assert ws.receive_json()["type"] == "channelData"  # the snapshot
        assert drain_stream(ws) == [
            "metadataChunk",
            "metadataChunk",
            "metadataComplete",
        ]
        # The client heard the file was rewritten: refresh re-runs just the
        # stream — no second snapshot, no registry churn.
        ws.send_json({"action": "refresh", **sub})
        assert drain_stream(ws) == [
            "metadataChunk",
            "metadataChunk",
            "metadataComplete",
        ]


def test_ws_refresh_sends_a_delta(ws_client, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import json

    client, s3 = ws_client
    rows = {str(n): {"exp_time": n} for n in range(1, 4)}
    key = f"lsstcam/{DATE}/metadata.json"
    s3.put_object(Bucket=TEST_BUCKET, Key=key, Body=json.dumps(rows).encode())
    sub = {"topic": "camera", "location": "test", "camera": "lsstcam", "date": DATE}

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe", **sub})
        assert ws.receive_json()["type"] == "channelData"
        while (msg := ws.receive_json())["type"] != "metadataComplete":
            pass
        etag = msg["etag"]
        assert etag
        # The producer appends a row and rewrites the file.
        s3.put_object(
            Bucket=TEST_BUCKET,
            Key=key,
            Body=json.dumps({**rows, "4": {"exp_time": 4}}).encode(),
        )
        ws.send_json({"action": "refresh", **sub, "since_etag": etag})
        msg = ws.receive_json()
        assert msg["type"] == "metadataDelta"
        assert msg["data"] == {"rows": {"4": {"exp_time": 4}}, "removed": []}
        assert msg["etag"] and msg["etag"] != etag
        # A version the server can't diff from falls back to the full stream.
        ws.send_json({"action": "refresh", **sub, "since_etag": "stale"})
        types = []
        while (msg := ws.receive_json())["type"] != "metadataComplete":
            types.append(msg["type"])
        assert types and set(types) == {"metadataChunk"}

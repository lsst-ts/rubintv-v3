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
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
from lsst.ts.rubintv.data.events import StoreChange
from lsst.ts.rubintv.data.store import EventStore
from lsst.ts.rubintv.ws import handler as handler_mod
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


def test_manager_keeps_a_topic_while_others_subscribe() -> None:
    # One subscriber leaving (unsubscribe or disconnect) must not cut the
    # topic off for the rest; unsubscribing from a topic never joined is a
    # no-op.
    topic = "camera|test|lsstcam"
    mgr = ConnectionManager()
    c1, c2, c3 = (Connection(id=i, socket=None) for i in "123")  # type: ignore[arg-type]
    mgr._connections.update({"1": c1, "2": c2, "3": c3})  # noqa: SLF001
    for conn in (c1, c2, c3):
        mgr.subscribe(conn, topic)
    mgr.unsubscribe(c1, topic)
    mgr.unsubscribe(c1, "camera|test|never-joined")
    mgr.disconnect(c3)
    mgr.publish_to_topic(topic, ServerMessage(type="channelData"))
    assert (c1.queue.qsize(), c2.queue.qsize(), c3.queue.qsize()) == (0, 1, 0)


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


CAMERA_SUB = {"topic": "camera", "location": "test", "camera": "lsstcam"}


class _LogRecorder:
    """Stands in for the handler's logger: records (level, event) pairs."""

    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    def __getattr__(self, level: str) -> Any:
        def record(event: str, **fields: object) -> None:
            self.events.append((level, event))

        return record


@pytest.fixture
def handler_log(monkeypatch: pytest.MonkeyPatch) -> _LogRecorder:
    recorder = _LogRecorder()
    monkeypatch.setattr(handler_mod, "log", recorder)
    return recorder


def test_ws_pump_survives_changes_it_cannot_deliver(
    ws_client: tuple[TestClient, Any],
    monkeypatch: pytest.MonkeyPatch,
    handler_log: _LogRecorder,
) -> None:
    # A change no topic wants is dropped, and one whose payload can't be
    # built is logged and dropped: neither may kill the pump, which would
    # silently stop every live update in the process.
    client, _ = ws_client
    state = client.app.state.app_state  # type: ignore[attr-defined]

    def unreadable() -> dict[str, object]:
        raise RuntimeError("detector store unreadable")

    monkeypatch.setattr(state.detectors, "all", unreadable)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe", **CAMERA_SUB})
        assert ws.receive_json()["type"] == "channelData"
        state.store.bus.publish(
            StoreChange("noSuchChange", "test", "lsstcam", DATE)  # type: ignore[arg-type]
        )
        state.store.bus.publish(StoreChange("detectorStatus", "*", ""))
        state.store.bus.publish(StoreChange("dayChange", "test", "lsstcam", DATE))
        assert ws.receive_json()["type"] == "dayChange"
    assert ("exception", "ws.pump.fan_out.error") in handler_log.events


def test_ws_admin_change_carries_the_readback(
    ws_client: tuple[TestClient, Any],
) -> None:
    # Admin subscribers get the whole control readback with each change, so
    # the page updates without a refetch.
    client, _ = ws_client
    state = client.app.state.app_state  # type: ignore[attr-defined]
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe", "topic": "admin", "location": ""})
        assert ws.receive_json()["data"] == {"controls": {}}
        state.controls.set("*", "AOS_READBACK", "tie")
        state.store.bus.publish(StoreChange("controlReadback", "*", ""))
        msg = ws.receive_json()
        assert msg["type"] == "controlReadback"
        assert msg["data"] == {"controls": {"AOS_READBACK": "tie"}}


def test_ws_night_report_topic_signals_without_a_snapshot(
    ws_client: tuple[TestClient, Any],
) -> None:
    # The Nightly Summary loads over REST; its topic only says when to
    # refetch, so subscribing sends nothing until a report changes.
    client, _ = ws_client
    state = client.app.state.app_state  # type: ignore[attr-defined]
    with client.websocket_connect("/ws") as ws:
        ws.send_json(
            {
                "action": "subscribe",
                "topic": "nightReport",
                "location": "test",
                "camera": "lsstcam",
            }
        )
        # Frames are handled in order: once this snapshot is back, the
        # nightReport subscription is registered, and it queued nothing.
        ws.send_json({"action": "subscribe", "topic": "admin", "location": ""})
        assert ws.receive_json()["type"] == "controlReadback"
        state.store.bus.publish(StoreChange("nightReport", "test", "lsstcam", DATE))
        msg = ws.receive_json()
        assert msg["type"] == "nightReport"
        assert msg["date"] == DATE


def test_ws_unsubscribe_stops_updates(ws_client: tuple[TestClient, Any]) -> None:
    client, _ = ws_client
    state = client.app.state.app_state  # type: ignore[attr-defined]
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe", **CAMERA_SUB})
        assert ws.receive_json()["type"] == "channelData"
        ws.send_json({"action": "unsubscribe", **CAMERA_SUB})
        ws.send_json({"action": "subscribe", "topic": "admin", "location": ""})
        assert ws.receive_json()["type"] == "controlReadback"
        state.store.bus.publish(StoreChange("dayChange", "test", "lsstcam", DATE))
        state.store.bus.publish(StoreChange("controlReadback", "*", ""))
        # The camera change went nowhere: the admin one is next.
        assert ws.receive_json()["type"] == "controlReadback"


def test_ws_metadata_change_is_a_hint_that_carries_no_rows(
    ws_client: tuple[TestClient, Any],
) -> None:
    # The rows travel over REST (/metadata/{date}/changes); the message only
    # says which date to ask about.
    client, _ = ws_client
    state = client.app.state.app_state  # type: ignore[attr-defined]
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe", **CAMERA_SUB})
        assert ws.receive_json()["type"] == "channelData"
        state.store.bus.publish(StoreChange("metadata", "test", "lsstcam", DATE))
        assert ws.receive_json() == {
            "type": "metadata",
            "location": "test",
            "camera": "lsstcam",
            "date": DATE,
            "data": None,
            "message": None,
        }


def test_ws_frames_from_a_page_loaded_before_the_stream_went_are_harmless(
    ws_client: tuple[TestClient, Any],
) -> None:
    # A tab still running the previous build subscribes with a date (once
    # the cue to stream that date's metadata) and sends "refresh" on every
    # rewrite. The first still subscribes it; the second is refused politely.
    client, _ = ws_client
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe", **CAMERA_SUB, "date": DATE})
        assert ws.receive_json()["type"] == "channelData"
        ws.send_json({"action": "refresh", **CAMERA_SUB, "date": DATE})
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"action": "subscribe", "topic": "admin", "location": ""})
        assert ws.receive_json()["type"] == "controlReadback"


def test_ws_quiet_connection_is_sent_heartbeats(
    ws_client: tuple[TestClient, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    # A page can't see the protocol's own pings, so a connection with nothing
    # to carry is sent heartbeats: silence then means the socket is dead.
    # Real frames still get through between them.
    monkeypatch.setattr(handler_mod, "HEARTBEAT_SECONDS", 0.01)
    client, _ = ws_client
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json() == {
            "type": "heartbeat",
            "location": None,
            "camera": None,
            "date": None,
            "data": None,
            "message": None,
        }
        ws.send_json({"action": "subscribe", **CAMERA_SUB})
        while (msg := ws.receive_json())["type"] == "heartbeat":
            pass
        assert msg["type"] == "channelData"


async def test_ws_service_stop_before_start_is_a_no_op() -> None:
    # Shutdown can run after a startup that failed before the pump began.
    service = WsService(EventStore(), None, None)  # type: ignore[arg-type]
    await service.stop()

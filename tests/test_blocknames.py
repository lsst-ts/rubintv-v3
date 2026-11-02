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

"""Block names: the bundled snapshot and the Zephyr Scale refresh."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
from email.message import Message
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse

import pytest
from lsst.ts.rubintv.data import blocknames
from lsst.ts.rubintv.data.blocknames import (
    BlockNameService,
    ZephyrError,
    fetch_zephyr_names,
    load_snapshot,
    token_identity,
)


def test_snapshot_ships_with_the_package() -> None:
    names = load_snapshot()
    assert len(names) > 500
    assert all(k.startswith("BLOCK-T") for k in names)
    assert isinstance(names["BLOCK-T750"], str)


class _Resp(io.BytesIO):
    def __enter__(self) -> _Resp:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def fake_zephyr(pages: dict[int, dict[str, Any]], seen: list[Any]):  # type: ignore[no-untyped-def]
    def urlopen(req: Any, timeout: float = 0) -> _Resp:
        seen.append(req)
        start = int(parse_qs(urlparse(req.full_url).query)["startAt"][0])
        return _Resp(json.dumps(pages[start]).encode())

    return urlopen


def test_fetch_follows_next_links(monkeypatch: pytest.MonkeyPatch) -> None:
    base = "https://zephyr.example/v2"
    pages: dict[int, dict[str, Any]] = {
        0: {
            "values": [{"key": "BLOCK-T1", "name": "One"}, {"key": "BLOCK-T2"}],
            "next": f"{base}/testcases?projectKey=BLOCK&maxResults=2&startAt=2",
        },
        2: {"values": [{"key": "BLOCK-T3", "name": "Three"}]},
    }
    seen: list[Any] = []
    monkeypatch.setattr(blocknames, "urlopen", fake_zephyr(pages, seen))

    names = fetch_zephyr_names(base, "tok", "BLOCK", page_size=2)

    assert names == {"BLOCK-T1": "One", "BLOCK-T3": "Three"}  # nameless case dropped
    assert seen[0].get_header("Authorization") == "Bearer tok"
    assert "projectKey=BLOCK" in seen[0].full_url


@pytest.mark.parametrize(
    ("exc", "message"),
    [
        (
            HTTPError("https://z/v2", 401, "Unauthorized", Message(), io.BytesIO()),
            "Zephyr HTTP 401: Unauthorized",
        ),
        (URLError("no route to host"), "Zephyr unreachable: "),
        (TimeoutError("timed out"), "Zephyr unreachable: timed out"),
    ],
    ids=["http", "url", "timeout"],
)
def test_fetch_failures_become_zephyr_errors(
    monkeypatch: pytest.MonkeyPatch, exc: Exception, message: str
) -> None:
    def urlopen(req: Any, timeout: float = 0) -> _Resp:
        raise exc

    monkeypatch.setattr(blocknames, "urlopen", urlopen)

    with pytest.raises(ZephyrError) as caught:
        fetch_zephyr_names("https://z/v2", "tok", "BLOCK")

    assert str(caught.value).startswith(message)
    assert caught.value.__cause__ is exc


def test_a_page_that_is_not_json_is_a_zephyr_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        blocknames, "urlopen", lambda req, timeout=0: _Resp(b"<html>login</html>")
    )

    with pytest.raises(ZephyrError, match=r"^Zephyr unreachable: "):
        fetch_zephyr_names("https://z/v2", "tok", "BLOCK")


async def test_refresh_merges_and_keeps_snapshot_on_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pages = {0: {"values": [{"key": "BLOCK-T9", "name": "Nine"}]}}
    monkeypatch.setattr(blocknames, "urlopen", fake_zephyr(pages, []))
    svc = BlockNameService(
        {"BLOCK-T1": "One"}, zephyr_url="https://z/v2", zephyr_token="t"
    )
    assert svc.refresh_enabled and svc.source == "snapshot"

    assert await svc.refresh()
    assert svc.names == {"BLOCK-T1": "One", "BLOCK-T9": "Nine"}
    assert svc.source == "zephyr" and svc.updated_at is not None

    def boom(*a: Any, **k: Any) -> None:
        raise ZephyrError("Zephyr HTTP 401: Unauthorized")

    monkeypatch.setattr(blocknames, "fetch_zephyr_names", boom)
    assert not await svc.refresh()
    assert "401" in (svc.error or "") and svc.names["BLOCK-T9"] == "Nine"


def fake_jwt(claims: dict[str, Any]) -> str:
    def part(obj: dict[str, Any]) -> str:
        raw = base64.urlsafe_b64encode(json.dumps(obj).encode()).decode()
        return raw.rstrip("=")

    return f"{part({'alg': 'HS256', 'typ': 'JWT'})}.{part(claims)}.sig"


def test_token_identity_names_the_account_without_the_token() -> None:
    token = fake_jwt(
        {
            "context": {
                "baseUrl": "https://rubinobs.atlassian.net",
                "user": {"accountId": "712020:abc"},
            },
            "exp": 1822316059,
        }
    )
    ident = token_identity(token)
    assert ident == {
        "token_sha256": hashlib.sha256(token.encode()).hexdigest()[:12],
        "jira": "https://rubinobs.atlassian.net",
        "account_id": "712020:abc",
        "token_expires": "2027-09-30T14:54:19+00:00",
    }
    assert not any(token in v for v in ident.values())


@pytest.mark.parametrize(
    "token",
    [
        "opaque-token",
        "a.!!!not base64!!!.c",
        "a.bm90IGpzb24.c",  # "not json"
        fake_jwt({"context": "flat", "exp": "soon"}),
        fake_jwt({"exp": 10**20}),
    ],
)
def test_token_identity_falls_back_to_the_fingerprint(token: str) -> None:
    assert list(token_identity(token)) == ["token_sha256"]


async def test_refresh_logs_which_account_connected_or_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged: list[tuple[str, dict[str, Any]]] = []
    for level in ("info", "warning"):
        monkeypatch.setattr(
            f"lsst.ts.rubintv.data.blocknames.log.{level}",
            lambda event, **kw: logged.append((event, kw)),
        )
    pages = {0: {"values": [{"key": "BLOCK-T9", "name": "Nine"}]}}
    monkeypatch.setattr(blocknames, "urlopen", fake_zephyr(pages, []))
    token = fake_jwt({"context": {"user": {"accountId": "712020:abc"}}})
    svc = BlockNameService({}, zephyr_url="https://z/v2", zephyr_token=token)

    assert await svc.refresh()

    def boom(*a: Any, **k: Any) -> None:
        raise ZephyrError("Zephyr HTTP 401: Unauthorized")

    monkeypatch.setattr(blocknames, "fetch_zephyr_names", boom)
    assert not await svc.refresh()
    BlockNameService({}, zephyr_url="https://z/v2", zephyr_token=None).start()

    assert [event for event, _ in logged] == [
        "blocknames.zephyr.connected",
        "blocknames.refresh.failed",
        "blocknames.zephyr.disabled",
    ]
    connected, failed = logged[0][1], logged[1][1]
    assert connected["account_id"] == failed["account_id"] == "712020:abc"
    assert connected["count"] == 1 and connected["project"] == "BLOCK"
    assert failed["error"] == "Zephyr HTTP 401: Unauthorized"


async def test_empty_fetch_is_not_applied(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(blocknames, "urlopen", fake_zephyr({0: {"values": []}}, []))
    svc = BlockNameService(
        {"BLOCK-T1": "One"}, zephyr_url="https://z/v2", zephyr_token="t"
    )
    assert not await svc.refresh()
    assert svc.names == {"BLOCK-T1": "One"} and svc.error


async def test_no_token_means_no_refresh() -> None:
    svc = BlockNameService({"a": "b"}, zephyr_url="https://z/v2", zephyr_token=None)
    assert not svc.refresh_enabled
    assert not await svc.refresh()
    svc.start()  # no task without a token
    await svc.stop()


async def test_refresh_loop_outlives_an_unexpected_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # refresh() turns a ZephyrError into svc.error itself; anything else (a
    # page of an unexpected shape, say) escapes it, and the loop must log it
    # and try again after the interval.
    calls: list[str] = []

    def fetch(base_url: str, token: str, project_key: str) -> dict[str, str]:
        calls.append(project_key)
        if len(calls) == 1:
            raise AttributeError("'list' object has no attribute 'get'")
        return {"BLOCK-T9": "Nine"}

    logged: list[str] = []
    monkeypatch.setattr(blocknames, "fetch_zephyr_names", fetch)
    monkeypatch.setattr(
        "lsst.ts.rubintv.data.blocknames.log.exception",
        lambda event, **kw: logged.append(event),
    )
    svc = BlockNameService(
        {"BLOCK-T1": "One"},
        zephyr_url="https://z/v2",
        zephyr_token="t",
        refresh_interval=600,
    )
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)
        if len(sleeps) == 2:
            raise asyncio.CancelledError  # as stop() would, mid-sleep

    with monkeypatch.context() as m:
        m.setattr(asyncio, "sleep", fake_sleep)
        with pytest.raises(asyncio.CancelledError):
            await svc._loop()

    assert logged == ["blocknames.refresh.error"]
    assert sleeps == [600, 600]
    assert svc.source == "zephyr" and svc.names["BLOCK-T9"] == "Nine"


async def test_stop_cancels_the_refresh_task() -> None:
    svc = BlockNameService({}, zephyr_url="https://z/v2", zephyr_token="t")
    svc.start()
    task = svc._task
    assert task is not None and not task.done()

    await svc.stop()

    assert task.cancelled() and svc._task is None
    await svc.stop()  # a second stop is a no-op


async def test_stop_during_a_refresh_ends_the_loop_without_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged: list[str] = []
    monkeypatch.setattr(
        "lsst.ts.rubintv.data.blocknames.log.exception",
        lambda event, **kw: logged.append(event),
    )
    svc = BlockNameService({}, zephyr_url="https://z/v2", zephyr_token="t")
    refreshing = asyncio.Event()

    async def hanging_refresh() -> bool:
        refreshing.set()
        await asyncio.Event().wait()  # a Zephyr call that never returns
        return False

    monkeypatch.setattr(svc, "refresh", hanging_refresh)
    svc.start()
    task = svc._task
    await refreshing.wait()

    await svc.stop()

    assert task is not None and task.cancelled()
    assert logged == []  # a shutdown is not a failed refresh

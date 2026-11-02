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

"""The ConsDB client against a fake ``urlopen``: the request it sends and
how each way the query can fail becomes a ``ConsDbError``."""

from __future__ import annotations

import io
import json
from collections.abc import Callable
from email.message import Message
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request

import pytest
from lsst.ts.rubintv.data import consdb
from lsst.ts.rubintv.data.consdb import ConsDbClient, ConsDbError

URL = "http://consdb.test/consdb/query"


class _Resp(io.BytesIO):
    def __enter__(self) -> _Resp:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class _UnreadableBody(io.BytesIO):
    def read(self, *args: Any) -> bytes:
        raise OSError("connection reset while reading the error body")


def answering(body: bytes, seen: list[tuple[Request, float]]) -> Callable[..., _Resp]:
    def urlopen(req: Request, timeout: float = 0) -> _Resp:
        seen.append((req, timeout))
        return _Resp(body)

    return urlopen


def raising(exc: BaseException) -> Callable[..., _Resp]:
    def urlopen(req: Request, timeout: float = 0) -> _Resp:
        raise exc

    return urlopen


def http_error(code: int, reason: str, body: io.BytesIO) -> HTTPError:
    return HTTPError(URL, code, reason, Message(), body)


async def test_query_posts_the_sql_and_returns_columns_and_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = {"columns": ["exposure_id", "day_obs"], "data": [[1, 20250412]]}
    seen: list[tuple[Request, float]] = []
    monkeypatch.setattr(consdb, "urlopen", answering(json.dumps(reply).encode(), seen))

    result = await ConsDbClient(URL, token="gt-secret", timeout=7.5).query("SELECT 1")

    assert result.columns == ["exposure_id", "day_obs"]
    assert result.records() == [{"exposure_id": 1, "day_obs": 20250412}]
    ((req, timeout),) = seen
    assert req.full_url == URL and req.get_method() == "POST"
    assert isinstance(req.data, bytes)
    assert json.loads(req.data) == {"query": "SELECT 1"}
    # urllib stores header names capitalised ("Content-type").
    assert req.get_header("Accept") == "application/json"
    assert req.get_header("Content-type") == "application/json"
    assert req.get_header("Authorization") == "Bearer gt-secret"
    assert timeout == 7.5


@pytest.mark.parametrize("token", [None, ""])
def test_no_token_sends_no_authorization_header(
    monkeypatch: pytest.MonkeyPatch, token: str | None
) -> None:
    # In the cluster ConsDB is reached without auth; a bare "Bearer" header
    # would be rejected by a Gafaelfawr-fronted endpoint.
    seen: list[tuple[Request, float]] = []
    reply = json.dumps({"columns": [], "data": []}).encode()
    monkeypatch.setattr(consdb, "urlopen", answering(reply, seen))

    ConsDbClient(URL, token=token).query_sync("SELECT 1")

    assert not seen[0][0].has_header("Authorization")


def test_http_error_reports_status_and_a_truncated_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A non-UTF-8 byte is replaced rather than failing the decode.
    body = io.BytesIO(b"\xff" + b"x" * 600)
    error = http_error(401, "Unauthorized", body)
    monkeypatch.setattr(consdb, "urlopen", raising(error))

    with pytest.raises(ConsDbError) as caught:
        ConsDbClient(URL).query_sync("SELECT 1")

    assert str(caught.value) == "ConsDB HTTP 401: Unauthorized �" + "x" * 499
    assert caught.value.__cause__ is error


def test_http_error_with_an_unreadable_body_still_reports_the_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    error = http_error(502, "Bad Gateway", _UnreadableBody())
    monkeypatch.setattr(consdb, "urlopen", raising(error))

    with pytest.raises(ConsDbError) as caught:
        ConsDbClient(URL).query_sync("SELECT 1")

    assert str(caught.value).rstrip() == "ConsDB HTTP 502: Bad Gateway"


@pytest.mark.parametrize(
    "exc",
    [
        URLError("[Errno 8] nodename nor servname provided"),
        TimeoutError("timed out"),
        ConnectionRefusedError(61, "Connection refused"),
    ],
    ids=["url", "timeout", "os"],
)
def test_transport_failures_are_unreachable(
    monkeypatch: pytest.MonkeyPatch, exc: Exception
) -> None:
    monkeypatch.setattr(consdb, "urlopen", raising(exc))

    with pytest.raises(ConsDbError, match=r"^ConsDB unreachable: ") as caught:
        ConsDbClient(URL).query_sync("SELECT 1")

    assert caught.value.__cause__ is exc


@pytest.mark.parametrize(
    "body",
    [b"<html>502 Bad Gateway</html>", b"\xff\xfe"],
    ids=["html", "not-utf8"],
)
def test_a_reply_that_is_not_json_is_reported_as_such(
    monkeypatch: pytest.MonkeyPatch, body: bytes
) -> None:
    monkeypatch.setattr(consdb, "urlopen", answering(body, []))

    with pytest.raises(ConsDbError, match=r"^ConsDB returned non-JSON: "):
        ConsDbClient(URL).query_sync("SELECT 1")


@pytest.mark.parametrize(
    "reply",
    [
        {"detail": "relation cdb_nope.exposure does not exist"},
        {"columns": ["a"]},
        {"columns": "a", "data": []},
        {"columns": ["a"], "data": None},
    ],
    ids=["error-detail", "no-data", "columns-not-list", "data-null"],
)
def test_a_reply_without_columns_and_data_lists_is_rejected(
    monkeypatch: pytest.MonkeyPatch, reply: dict[str, Any]
) -> None:
    monkeypatch.setattr(consdb, "urlopen", answering(json.dumps(reply).encode(), []))

    with pytest.raises(ConsDbError, match=r"lacks 'columns'/'data'"):
        ConsDbClient(URL).query_sync("SELECT 1")

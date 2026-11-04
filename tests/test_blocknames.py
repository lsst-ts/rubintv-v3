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

"""Block names: the bundled snapshot and the Zephyr Scale and Jira refresh."""

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
    KNOWN_TYPOS,
    BlockNameService,
    JiraError,
    ZephyrError,
    basic_account,
    fetch_jira_names,
    fetch_zephyr_execution,
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


def fake_zephyr(  # type: ignore[no-untyped-def]
    pages: dict[int, dict[str, Any]],
    seen: list[Any],
    cases: dict[str, Any] | None = None,
):
    """Serve list pages by ``startAt``, and single test cases from ``cases``
    (404 for any other key)."""

    def urlopen(req: Any, timeout: float = 0) -> _Resp:
        seen.append(req)
        url = urlparse(req.full_url)
        if url.path.endswith("/testcases"):
            start = int(parse_qs(url.query)["startAt"][0])
            return _Resp(json.dumps(pages[start]).encode())
        key = url.path.rsplit("/", 1)[1]
        if key not in (cases or {}):
            raise HTTPError(req.full_url, 404, "Not Found", Message(), io.BytesIO())
        case = cases[key]  # type: ignore[index]
        if isinstance(case, Exception):
            raise case
        return _Resp(json.dumps(case).encode())

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


def test_test_cases_the_list_leaves_out_are_fetched_one_by_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pages: dict[int, dict[str, Any]] = {
        0: {
            "values": [
                {"key": "BLOCK-T1", "name": "One"},
                {"key": "BLOCK-T6", "name": "Six"},
            ]
        },
    }
    # Of the keys between, only BLOCK-T2 exists; T3..T5 answer 404.
    cases = {"BLOCK-T2": {"key": "BLOCK-T2", "name": "Two (archived)"}}
    seen: list[Any] = []
    monkeypatch.setattr(blocknames, "urlopen", fake_zephyr(pages, seen, cases))

    names = fetch_zephyr_names("https://z/v2", "tok", "BLOCK")

    assert names == {"BLOCK-T1": "One", "BLOCK-T2": "Two (archived)", "BLOCK-T6": "Six"}
    asked = [urlparse(r.full_url).path for r in seen[1:]]
    assert asked == [f"/v2/testcases/BLOCK-T{n}" for n in (2, 3, 4, 5)]
    assert all(r.get_header("Authorization") == "Bearer tok" for r in seen)


def test_a_failing_single_lookup_fails_the_fetch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pages: dict[int, dict[str, Any]] = {
        0: {"values": [{"key": "BLOCK-T3", "name": "3"}]}
    }
    boom = HTTPError("https://z", 500, "Server Error", Message(), io.BytesIO())
    monkeypatch.setattr(
        blocknames, "urlopen", fake_zephyr(pages, [], {"BLOCK-T2": boom})
    )

    with pytest.raises(ZephyrError, match="^Zephyr HTTP 500: Server Error$"):
        fetch_zephyr_names("https://z/v2", "tok", "BLOCK")


def test_a_page_that_is_not_an_object_is_a_zephyr_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(blocknames, "urlopen", lambda req, timeout=0: _Resp(b"[]"))

    with pytest.raises(ZephyrError, match="^Zephyr returned an unexpected page$"):
        fetch_zephyr_names("https://z/v2", "tok", "BLOCK")


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
        "blocknames.jira.disabled",
    ]
    connected, failed = logged[0][1], logged[1][1]
    assert connected["account_id"] == failed["account_id"] == "712020:abc"
    assert connected["count"] == 1 and connected["project"] == "BLOCK"
    assert failed["error"] == "Zephyr HTTP 401: Unauthorized"


def fake_jira(pages: dict[str, Any], seen: list[Any]):  # type: ignore[no-untyped-def]
    def urlopen(req: Any, timeout: float = 0) -> _Resp:
        seen.append(req)
        query = parse_qs(urlparse(req.full_url).query)
        return _Resp(json.dumps(pages[query.get("nextPageToken", [""])[0]]).encode())

    return urlopen


# Jira Cloud's basic-auth credential, as nightlydigest's secret holds it.
CREDENTIAL = base64.b64encode(b"me@example.org:secret-token").decode()


def test_basic_account_names_the_account_only() -> None:
    assert basic_account(CREDENTIAL) == "me@example.org"
    for not_one in ("secret-token", "!!!", base64.b64encode(b"no colon").decode()):
        assert basic_account(not_one) is None


def test_jira_fetch_follows_next_page_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    pages: dict[str, Any] = {
        "": {
            "issues": [
                {"key": "BLOCK-365", "fields": {"summary": "Generic survey block "}},
                {"key": "BLOCK-366", "fields": {}},  # no summary: dropped
                "not an issue",
            ],
            "nextPageToken": "p2",
            "isLast": False,
        },
        "p2": {"issues": [{"key": "BLOCK-407", "fields": {"summary": "v1 survey"}}]},
    }
    seen: list[Any] = []
    monkeypatch.setattr(blocknames, "urlopen", fake_jira(pages, seen))

    names = fetch_jira_names("https://jira.example/", CREDENTIAL, "BLOCK")

    assert names == {"BLOCK-365": "Generic survey block", "BLOCK-407": "v1 survey"}
    assert len(seen) == 2
    # Sent as it is, the way nightlydigest sends the secret.
    assert seen[0].get_header("Authorization") == f"Basic {CREDENTIAL}"
    url = urlparse(seen[0].full_url)
    assert url.path == "/rest/api/3/search/jql"
    assert parse_qs(url.query)["jql"] == ['project = "BLOCK" ORDER BY key']


@pytest.mark.parametrize(
    ("body", "message"),
    [
        (b"<html>login</html>", "Jira unreachable: "),
        (b"[]", "Jira returned an unexpected page"),
    ],
    ids=["not-json", "not-an-object"],
)
def test_a_bad_jira_page_is_a_jira_error(
    monkeypatch: pytest.MonkeyPatch, body: bytes, message: str
) -> None:
    monkeypatch.setattr(blocknames, "urlopen", lambda req, timeout=0: _Resp(body))

    with pytest.raises(JiraError, match=f"^{message}"):
        fetch_jira_names("https://j", CREDENTIAL, "BLOCK")


def test_jira_http_failure_is_a_jira_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def urlopen(req: Any, timeout: float = 0) -> _Resp:
        raise HTTPError("https://j", 401, "Unauthorized", Message(), io.BytesIO())

    monkeypatch.setattr(blocknames, "urlopen", urlopen)

    with pytest.raises(JiraError, match="^Jira HTTP 401: Unauthorized$"):
        fetch_jira_names("https://j", CREDENTIAL, "BLOCK")


def both_sources(**overrides: Any) -> BlockNameService:
    kwargs: dict[str, Any] = {
        "zephyr_url": "https://z/v2",
        "zephyr_token": "zt",
        "jira_url": "https://j",
        "jira_credential": CREDENTIAL,
    }
    return BlockNameService({"BLOCK-T1": "One"}, **{**kwargs, **overrides})


async def test_refresh_takes_names_from_both_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        blocknames, "fetch_zephyr_names", lambda *a: {"BLOCK-T365": "M20-M8 field"}
    )
    monkeypatch.setattr(
        blocknames, "fetch_jira_names", lambda *a: {"BLOCK-365": "Survey imaging"}
    )
    svc = both_sources()

    assert await svc.refresh()

    # BLOCK-365 and BLOCK-T365 are different blocks with names of their own.
    assert svc.names == {
        "BLOCK-T1": "One",
        "BLOCK-T365": "M20-M8 field",
        "BLOCK-365": "Survey imaging",
    }
    assert svc.source == "zephyr+jira" and svc.error is None


async def test_one_source_failing_keeps_its_names_and_takes_the_other(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(blocknames, "fetch_zephyr_names", lambda *a: {"BLOCK-T9": "9"})
    monkeypatch.setattr(blocknames, "fetch_jira_names", lambda *a: {"BLOCK-365": "S"})
    svc = both_sources()
    assert await svc.refresh()

    def boom(*a: Any) -> None:
        raise JiraError("Jira HTTP 401: Unauthorized")

    monkeypatch.setattr(blocknames, "fetch_jira_names", boom)
    monkeypatch.setattr(
        blocknames, "fetch_zephyr_names", lambda *a: {"BLOCK-T9": "Nine"}
    )

    assert await svc.refresh()
    assert svc.names["BLOCK-T9"] == "Nine" and svc.names["BLOCK-365"] == "S"
    assert svc.error == "Jira HTTP 401: Unauthorized"
    assert svc.source == "zephyr+jira"

    monkeypatch.setattr(blocknames, "fetch_jira_names", lambda *a: {})
    assert await svc.refresh()
    assert svc.error == "Jira returned no issues"


async def test_jira_alone_with_a_credential_wrapped_over_lines(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[Any, ...]] = []

    def fetch(*args: Any) -> dict[str, str]:
        calls.append(args)
        return {"BLOCK-365": "S"}

    monkeypatch.setattr(blocknames, "fetch_jira_names", fetch)
    wrapped = f"{CREDENTIAL[:20]}\n{CREDENTIAL[20:]}\n"
    svc = both_sources(zephyr_token=None, jira_credential=wrapped)

    assert await svc.refresh()
    assert svc.source == "jira"
    assert calls == [("https://j", CREDENTIAL, "BLOCK")]
    assert not both_sources(zephyr_token=None, jira_credential=" ").refresh_enabled


def test_a_bare_api_token_is_flagged_at_start(monkeypatch: pytest.MonkeyPatch) -> None:
    warned: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        "lsst.ts.rubintv.data.blocknames.log.warning",
        lambda event, **kw: warned.append((event, kw)),
    )
    monkeypatch.setattr(asyncio, "create_task", lambda coro, name=None: coro.close())

    both_sources(jira_credential="ATATT-bare-token").start()
    both_sources().start()  # a proper credential: no warning

    assert [event for event, _ in warned] == ["blocknames.jira.credential_unrecognised"]
    assert "account" not in warned[0][1]
    assert not any("ATATT" in str(v) for v in warned[0][1].values())


async def test_jira_refresh_logs_the_account_without_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        "lsst.ts.rubintv.data.blocknames.log.info",
        lambda event, **kw: logged.append((event, kw)),
    )
    monkeypatch.setattr(blocknames, "fetch_jira_names", lambda *a: {"BLOCK-365": "S"})
    svc = both_sources(zephyr_token=None)

    await svc.refresh()

    assert logged == [
        (
            "blocknames.jira.connected",
            {
                "project": "BLOCK",
                "count": 1,
                "token_sha256": hashlib.sha256(CREDENTIAL.encode()).hexdigest()[:12],
                "jira": "https://j",
                "account": "me@example.org",
            },
        )
    ]
    assert not any("secret-token" in str(v) for v in logged[0][1].values())


def test_an_execution_names_the_test_case_it_ran(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executions = {
        "BLOCK-E8024": {
            "testCase": {"self": "https://z/v2/testcases/BLOCK-T382/versions/1"}
        },
        "BLOCK-E9": {"testCase": None},
    }
    seen: list[Any] = []

    def urlopen(req: Any, timeout: float = 0) -> _Resp:
        seen.append(req)
        key = urlparse(req.full_url).path.rsplit("/", 1)[1]
        if key not in executions:
            raise HTTPError(req.full_url, 404, "Not Found", Message(), io.BytesIO())
        return _Resp(json.dumps(executions[key]).encode())

    monkeypatch.setattr(blocknames, "urlopen", urlopen)

    assert fetch_zephyr_execution("https://z/v2/", "tok", "BLOCK-E8024") == "BLOCK-T382"
    assert urlparse(seen[0].full_url).path == "/v2/testexecutions/BLOCK-E8024"
    assert seen[0].get_header("Authorization") == "Bearer tok"
    assert fetch_zephyr_execution("https://z/v2", "tok", "BLOCK-E9") is None
    assert fetch_zephyr_execution("https://z/v2", "tok", "BLOCK-E1") is None


def with_programs(programs: list[str], **overrides: Any) -> BlockNameService:
    kwargs: dict[str, Any] = {"zephyr_url": "https://z/v2", "zephyr_token": "zt"}
    return BlockNameService({}, programs=lambda: programs, **{**kwargs, **overrides})


async def test_executions_observed_as_programs_are_looked_up_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked: list[str] = []
    runs = {"BLOCK-E13304": "BLOCK-T382", "BLOCK-E8024": "BLOCK-T382"}

    def fetch(base_url: str, token: str, key: str) -> str | None:
        asked.append(key)
        return runs.get(key)

    monkeypatch.setattr(blocknames, "fetch_zephyr_execution", fetch)
    programs = ["E13304", "BLOCK-E8024", "e77", "BLOCK-T1", "E5_v2", "Test_images"]
    svc = with_programs(programs)

    assert await svc.resolve_executions() == 2
    # Bare and prefixed keys alike, read as the project's execution keys.
    assert sorted(asked) == ["BLOCK-E13304", "BLOCK-E77", "BLOCK-E8024"]
    assert svc.aliases == {
        **KNOWN_TYPOS,
        "BLOCK-E13304": "BLOCK-T382",
        "BLOCK-E8024": "BLOCK-T382",
    }

    # Nothing new: found ones and unknown ones (E77) aren't asked for again.
    asked.clear()
    programs.append("E5852")
    runs["BLOCK-E5852"] = "BLOCK-T485"
    assert await svc.resolve_executions() == 1
    assert asked == ["BLOCK-E5852"]


async def test_a_failed_execution_lookup_waits_for_the_next_round(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failing = {"BLOCK-E1"}

    def fetch(base_url: str, token: str, key: str) -> str | None:
        if key in failing:
            raise ZephyrError("Zephyr unreachable: timed out")
        return "BLOCK-T1"

    monkeypatch.setattr(blocknames, "fetch_zephyr_execution", fetch)
    svc = with_programs(["E1", "E2"])

    assert await svc.resolve_executions() == 0  # E1 failed first; E2 waits
    failing.clear()
    assert await svc.resolve_executions() == 2


async def test_executions_need_programs_and_a_zephyr_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fetch(*a: Any) -> str:
        raise AssertionError("no lookup expected")

    monkeypatch.setattr(blocknames, "fetch_zephyr_execution", fetch)
    assert await with_programs(["E1"], zephyr_token=None).resolve_executions() == 0
    assert (
        await BlockNameService(
            {}, zephyr_url="u", zephyr_token="t"
        ).resolve_executions()
        == 0
    )
    # The typos are aliases whatever is configured.
    assert BlockNameService({}).aliases == KNOWN_TYPOS


async def test_the_execution_loop_starts_with_programs_and_stops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(blocknames, "fetch_zephyr_names", lambda *a: {"BLOCK-T1": "1"})
    monkeypatch.setattr(blocknames, "fetch_zephyr_execution", lambda *a: "BLOCK-T382")
    svc = with_programs(["E8024"], execution_check_interval=3600)
    svc.start()
    task = svc._execution_task
    assert task is not None
    for _ in range(50):  # let the first round run
        if svc.aliases.get("BLOCK-E8024"):
            break
        await asyncio.sleep(0.01)

    await svc.stop()

    assert svc.aliases["BLOCK-E8024"] == "BLOCK-T382"
    assert task.cancelled() and svc._execution_task is None
    # No programs to look through: no loop.
    plain = BlockNameService({}, zephyr_url="u", zephyr_token="t")
    plain.start()
    assert plain._execution_task is None
    await plain.stop()


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

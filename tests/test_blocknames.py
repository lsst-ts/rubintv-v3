"""Block names: the bundled snapshot and the Zephyr Scale refresh."""

from __future__ import annotations

import io
import json
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from lsst.ts.rubintv.data import blocknames
from lsst.ts.rubintv.data.blocknames import (
    BlockNameService,
    ZephyrError,
    fetch_zephyr_names,
    load_snapshot,
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
    pages = {
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

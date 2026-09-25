"""The guide's REST surface, with and without a ConsDB configured."""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import boto3
import pytest
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
from lsst.ts.rubintv.data import consdb
from lsst.ts.rubintv.data.consdb import QueryResult
from moto import mock_aws

from tests.conftest import CONFIG_PATH, TEST_BUCKET, PrefixedTestClient
from tests.test_guide import COLUMNS, row


@contextmanager
def run_app(**overrides: object) -> Iterator[PrefixedTestClient]:
    settings = Settings(
        models_path=CONFIG_PATH,
        site="test",
        poll_interval_seconds=0.05,
        cache_dir=None,
        **overrides,  # type: ignore[arg-type]
    )
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=TEST_BUCKET)
        with PrefixedTestClient(create_app(settings)) as client:
            yield client


def test_guide_is_disabled_without_a_consdb_url() -> None:
    with run_app() as app:
        cfg = app.get("/api/guide").json()
        assert cfg["enabled"] is False and cfg["instruments"] == []
        assert cfg["day_start_utc_hour"] == 12
        assert app.get("/api/guide/lsstcam/blocks").status_code == 404
        names = app.get("/api/guide/programs").json()
        assert names["source"] == "snapshot" and "BLOCK-T750" in names["names"]


def test_blocks_are_served_once_the_sweep_completes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    rows = [row(1, "BLOCK-T1", 0), row(2, "BLOCK-T1", 1), row(3, "BLOCK-T2", 40)]
    seen: list[str] = []

    def fake_query(self: consdb.ConsDbClient, sql: str) -> QueryResult:
        seen.append(sql)
        return (
            QueryResult(COLUMNS, rows) if len(seen) == 1 else QueryResult(COLUMNS, [])
        )

    monkeypatch.setattr(consdb.ConsDbClient, "query_sync", fake_query)
    token = tmp_path / "token"
    token.write_text("secret\n")

    with run_app(
        consdb_url="http://consdb.test/consdb/query",
        consdb_token_file=token,
        guide_instruments=["lsstcam", "latiss"],
        guide_poll_interval_seconds=3600,
    ) as app:
        cfg = app.get("/api/guide").json()
        assert cfg["enabled"]
        assert [i["name"] for i in cfg["instruments"]] == ["lsstcam", "latiss"]
        lsstcam = cfg["instruments"][0]
        # The test site's one location carries an lsstcam camera.
        assert lsstcam["location"] == "test" and lsstcam["camera"] == "lsstcam"
        assert "{dayObs}" in lsstcam["image_viewer_link"]
        # ConsDB's latiss is RubinTV's auxtel camera.
        latiss = cfg["instruments"][1]
        assert (latiss["location"], latiss["camera"]) == ("test", "auxtel")

        deadline = time.monotonic() + 5
        while True:
            body = app.get("/api/guide/lsstcam/blocks").json()
            if not body["loading"] or time.monotonic() > deadline:
                break
            time.sleep(0.05)

        assert body["loading"] is False and body["error"] is None
        assert [
            (b["program"], b["seq_num_0"], b["seq_num_1"]) for b in body["blocks"]
        ] == [
            ("BLOCK-T1", 1, 2),
            ("BLOCK-T2", 3, 3),
        ]
        assert body["blocks"][0]["begin"].endswith("Z")
        assert body["blocks"][0]["day_obs"] == 20250411
        assert body["exposures"] == 3
        assert app.get("/api/guide/latiss/blocks").status_code == 200
        assert app.get("/api/guide/nope/blocks").status_code == 404
    assert any("cdb_lsstcam.exposure" in s for s in seen)
    assert any("cdb_latiss.exposure" in s for s in seen)

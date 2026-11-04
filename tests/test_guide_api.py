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
    # _env_file=None: a developer's .env (a ConsDB URL, a Zephyr token) must
    # not reach these apps.
    settings = Settings(
        _env_file=None,
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
        # The interim names for plain BLOCK-123 programs, until Jira's arrive.
        assert names["names"]["BLOCK-365"].startswith("Generic survey imaging")
        assert names["aliases"]["BLOCK-487"] == "BLOCK-T487"


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


def test_an_instrument_with_no_camera_is_served_without_links(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # ConsDB's lsstcomcam has no RubinTV camera of that name (nor an alias),
    # so its blocks are served but there is no camera page to link them to.
    def fake_query(self: consdb.ConsDbClient, sql: str) -> QueryResult:
        return QueryResult(COLUMNS, [])

    monkeypatch.setattr(consdb.ConsDbClient, "query_sync", fake_query)

    with run_app(
        consdb_url="http://consdb.test/consdb/query",
        guide_instruments=["lsstcam", "lsstcomcam"],
        guide_poll_interval_seconds=3600,
    ) as app:
        instruments = app.get("/api/guide").json()["instruments"]
        assert instruments[1] == {
            "name": "lsstcomcam",
            "location": None,
            "camera": None,
            "image_viewer_link": None,
            "quicklook_viewer_link": None,
        }
        assert instruments[0]["camera"] == "lsstcam"
        assert app.get("/api/guide/lsstcomcam/blocks").status_code == 200

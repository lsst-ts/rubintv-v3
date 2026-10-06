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

"""Settings normalisation, esp. the RAPID_ANALYSIS_LOCATION site alias.

The Rapid Analysis environment sets ``RAPID_ANALYSIS_LOCATION`` to its own
codes (``BTS``/``TTS``/``SUMMIT``/``USDF``); the config keys sites by the
internal names (``base``/``tucson``/``summit``/``usdf-k8s``). ``Settings``
translates at the boundary so a ``USDF`` pod doesn't crash on startup with
``unknown site 'USDF'`` when the loader filters ``bucket_configurations``.
"""

from __future__ import annotations

from pathlib import Path

import lsst.ts.rubintv.models as models_pkg
import pytest
from lsst.ts.rubintv.config.loader import load_models
from lsst.ts.rubintv.config.settings import Settings

CONFIG_PATH = Path(models_pkg.__file__).parent / "models_data.yaml"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("BTS", "base"),
        ("TTS", "tucson"),
        ("SUMMIT", "summit"),
        ("USDF", "usdf-k8s"),
    ],
)
def test_rapid_analysis_codes_map_to_internal_site(
    raw: str, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Via the RAPID_ANALYSIS_LOCATION env alias (the deployed path)...
    monkeypatch.setenv("RAPID_ANALYSIS_LOCATION", raw)
    assert Settings(_env_file=None).site == expected
    # ...and via the field name (the path tests use).
    assert Settings(site=raw).site == expected


@pytest.mark.parametrize("site", ["usdf-k8s", "summit", "base", "local", "gha", "test"])
def test_internal_site_names_pass_through(site: str) -> None:
    assert Settings(site=site).site == site


def test_default_site_is_local() -> None:
    assert Settings(_env_file=None).site == "local"


def test_usdf_pod_loads_its_locations_without_crashing() -> None:
    # Regression: RAPID_ANALYSIS_LOCATION=USDF once reached the loader raw and
    # raised ConfigError("unknown site 'USDF'"), borking startup.
    site = Settings(site="USDF").site
    models = load_models(CONFIG_PATH, site=site)
    assert {loc.name for loc in models.locations} == {
        "summit-usdf",
        "usdf",
        "base-usdf",
        "tucson-usdf",
    }


def test_redis_url_is_built_from_the_chart_ra_redis_parts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The Phalanx chart passes host + secret password separately (the names
    # the previous app read), not a URL; without this Redis stayed disabled.
    monkeypatch.setenv("RA_REDIS_HOST", "redis-service.rapid-analysis.svc")
    assert (
        Settings(_env_file=None).redis_url
        == "redis://redis-service.rapid-analysis.svc:6379"
    )
    monkeypatch.setenv("RA_REDIS_PASSWORD", "p@ss/w:rd")
    monkeypatch.setenv("RA_REDIS_PORT", "6380")
    assert (
        Settings(_env_file=None).redis_url
        == "redis://:p%40ss%2Fw%3Ard@redis-service.rapid-analysis.svc:6380"
    )


def test_explicit_redis_url_beats_the_ra_redis_parts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RA_REDIS_HOST", "ignored")
    monkeypatch.setenv("RUBINTV_REDIS_URL", "redis://explicit:6379/2")
    assert Settings(_env_file=None).redis_url == "redis://explicit:6379/2"


def test_redis_stays_disabled_without_a_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RA_REDIS_HOST", raising=False)
    monkeypatch.delenv("RUBINTV_REDIS_URL", raising=False)
    monkeypatch.setenv("RA_REDIS_PASSWORD", "orphan")
    assert Settings(_env_file=None).redis_url is None

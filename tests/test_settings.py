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


@pytest.mark.parametrize(
    "site", ["usdf-k8s", "summit", "base", "local", "gha", "test"]
)
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

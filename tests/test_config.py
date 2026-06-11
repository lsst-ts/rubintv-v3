"""Config loader: valid parse, defaults, fail-loud behaviour, site filtering."""

from __future__ import annotations

from pathlib import Path

import pytest

from rubintv.config.loader import ConfigError, load_models

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "models_data.yaml"


def test_loads_sample_config() -> None:
    models = load_models(CONFIG_PATH, site="test")

    test_loc = models.location("test")
    assert test_loc is not None
    assert test_loc.bucket == "rubintv-local"
    # camera_groups resolved to Camera objects, de-duplicated, in order.
    assert [c.name for c in test_loc.cameras] == ["lsstcam", "auxtel", "allsky"]


def test_channel_label_defaults_to_title() -> None:
    models = load_models(CONFIG_PATH, site="test")
    lsstcam = models.location("test").camera("lsstcam")  # type: ignore[union-attr]
    assert lsstcam is not None
    witness = lsstcam.channel("witness_detector")
    assert witness is not None
    assert witness.label == "Witness Detector"


def test_per_day_flag_parsed() -> None:
    models = load_models(CONFIG_PATH, site="test")
    lsstcam = models.location("test").camera("lsstcam")  # type: ignore[union-attr]
    assert lsstcam.channel("day_movie").per_day is True  # type: ignore[union-attr]
    assert lsstcam.channel("witness_detector").per_day is False  # type: ignore[union-attr]


def test_live_view_flag_on_allsky() -> None:
    models = load_models(CONFIG_PATH, site="test")
    allsky = models.location("test").camera("allsky")  # type: ignore[union-attr]
    assert allsky is not None
    assert allsky.live_view is True
    lsstcam = models.location("test").camera("lsstcam")  # type: ignore[union-attr]
    assert lsstcam is not None
    assert lsstcam.live_view is False


def test_site_filtering_restricts_locations() -> None:
    # `usdf-k8s` site sees the four buckets it can reach.
    models = load_models(CONFIG_PATH, site="usdf-k8s")
    assert {loc.name for loc in models.locations} == {
        "usdf",
        "base-usdf",
        "tucson-usdf",
        "summit-usdf",
    }
    # `summit` site sees only its own bucket.
    summit = load_models(CONFIG_PATH, site="summit")
    assert {loc.name for loc in summit.locations} == {"summit"}


def test_unknown_site_fails_loud() -> None:
    with pytest.raises(ConfigError, match="unknown site"):
        load_models(CONFIG_PATH, site="not-a-site")


def test_metadata_columns_merged_from_global_map() -> None:
    """Top-level metadata_columns are merged onto the named camera."""
    models = load_models(CONFIG_PATH, site="test")
    lsstcam = models.location("test").camera("lsstcam")  # type: ignore[union-attr]
    assert "Retrieval fails" in lsstcam.metadata_columns  # type: ignore[union-attr]


def test_metadata_from_inheritance() -> None:
    """metadata_from copies columns from a source camera."""
    models = load_models(CONFIG_PATH, site="summit")
    # startracker_wide inherits from startracker_narrow.
    wide = models.location("summit").camera("startracker_wide")  # type: ignore[union-attr]
    assert wide is not None
    # The shared 'narrow' columns are present even though wide doesn't list them.
    assert any("narrow" in c for c in wide.metadata_columns)
    # The metadata_from field is resolved to None after inheritance is applied.
    assert wide.metadata_from is None


def test_admin_users_picked_up_from_admin_for() -> None:
    """admin_users on each location come from the global admin_for[site] list."""
    models = load_models(CONFIG_PATH, site="test")
    assert "testadmin" in models.location("test").admin_users  # type: ignore[union-attr]
    assert "*" in models.location("test").admin_users  # type: ignore[union-attr]


def test_redis_detectors_and_admin_menus_parsed() -> None:
    models = load_models(CONFIG_PATH, site="test")
    assert any(d.name == "sfmSet0" for d in models.redis_detectors)
    menus = {m.title for m in models.admin_redis_menus}
    assert "AOS Pipeline" in menus


def test_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="not found"):
        load_models(tmp_path / "nope.yaml")


def test_unknown_camera_reference_fails_loud(tmp_path: Path) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "cameras: []\n"
        "locations:\n"
        "  - name: local\n"
        "    title: Local\n"
        "    bucket: b\n"
        "    camera_groups:\n"
        "      Main: [ghost_camera]\n"
    )
    with pytest.raises(ConfigError, match="unknown camera 'ghost_camera'"):
        load_models(bad)


def test_duplicate_camera_fails_loud(tmp_path: Path) -> None:
    bad = tmp_path / "dup.yaml"
    bad.write_text(
        "cameras:\n  - {name: x, title: X}\n  - {name: x, title: X2}\nlocations: []\n"
    )
    with pytest.raises(ConfigError, match="duplicate camera"):
        load_models(bad)


def test_unknown_metadata_from_fails_loud(tmp_path: Path) -> None:
    bad = tmp_path / "bad_inherit.yaml"
    bad.write_text(
        "cameras:\n"
        "  - {name: a, title: A, metadata_from: ghost}\n"
        "locations: []\n"
    )
    with pytest.raises(ConfigError, match="metadata_from unknown camera 'ghost'"):
        load_models(bad)

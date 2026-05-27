"""Config loader: valid parse, defaults, and fail-loud behaviour."""

from __future__ import annotations

from pathlib import Path

import pytest

from rubintv.config.loader import ConfigError, load_models

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "models_data.yaml"


def test_loads_sample_config() -> None:
    models = load_models(CONFIG_PATH)

    local = models.location("local")
    assert local is not None
    assert local.bucket == "rubintv-local"
    # camera_groups resolved to Camera objects, de-duplicated, in order.
    assert [c.name for c in local.cameras] == ["lsstcam", "auxtel", "allsky"]


def test_channel_label_defaults_to_title() -> None:
    models = load_models(CONFIG_PATH)
    lsstcam = models.location("local").camera("lsstcam")  # type: ignore[union-attr]
    assert lsstcam is not None
    witness = lsstcam.channel("witness_detector")
    assert witness is not None
    assert witness.label == "Witness Detector"


def test_per_day_flag_parsed() -> None:
    models = load_models(CONFIG_PATH)
    lsstcam = models.location("local").camera("lsstcam")  # type: ignore[union-attr]
    assert lsstcam.channel("day_movie").per_day is True  # type: ignore[union-attr]
    assert lsstcam.channel("witness_detector").per_day is False  # type: ignore[union-attr]


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

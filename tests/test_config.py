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

"""Config loader: valid parse, defaults, fail-loud behaviour, site
filtering."""

from __future__ import annotations

from importlib.resources import files
from pathlib import Path

import pytest
from lsst.ts.rubintv.config.loader import ConfigError, load_models
from lsst.ts.rubintv.config.models import Models

# Packaged copy of the models YAML — the single source of truth.
CONFIG_PATH = Path(str(files("lsst.ts.rubintv.models").joinpath("models_data.yaml")))


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
    # The shared 'narrow' columns are present even though wide doesn't list
    # them.
    assert any("narrow" in c for c in wide.metadata_columns)
    # The metadata_from field is resolved to None after inheritance is applied.
    assert wide.metadata_from is None


def test_locked_columns_merged_from_global_map() -> None:
    """Top-level locked_columns are attached to the named camera."""
    models = load_models(CONFIG_PATH, site="test")
    lsstcam = models.location("test").camera("lsstcam")  # type: ignore[union-attr]
    assert "Retrieval fails" in lsstcam.locked_columns  # type: ignore[union-attr]
    # A camera without an entry has no locked columns.
    auxtel = models.location("test").camera("auxtel")  # type: ignore[union-attr]
    assert auxtel.locked_columns == []  # type: ignore[union-attr]


def test_locked_columns_inherited_via_metadata_from(tmp_path: Path) -> None:
    """locked_columns follow metadata_from inheritance, deduped with the
    child's."""
    cfg = tmp_path / "models.yaml"
    cfg.write_text(
        "locations:\n"
        "  - {name: loc, title: Loc, bucket_name: b, camera_groups: {G: [src, dst]}}\n"
        "cameras:\n"
        "  - {name: src, title: Src}\n"
        "  - {name: dst, title: Dst, metadata_from: src}\n"
        "locked_columns:\n"
        "  src: [Retrieval fails]\n"
        "  dst: [Retrieval fails, Other]\n"
    )
    models = load_models(cfg)
    dst = models.location("loc").camera("dst")  # type: ignore[union-attr]
    # Inherited from src, deduped against the child's own list (order
    # preserved).
    assert dst.locked_columns == ["Retrieval fails", "Other"]  # type: ignore[union-attr]


def test_locked_columns_must_be_a_list(tmp_path: Path) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "locations:\n"
        "  - {name: loc, title: Loc, bucket_name: b, camera_groups: {G: [a]}}\n"
        "cameras:\n"
        "  - {name: a, title: A}\n"
        "locked_columns:\n"
        "  a: {Retrieval fails: nope}\n"
    )
    with pytest.raises(ConfigError, match="locked_columns for 'a' must be a list"):
        load_models(bad)


def test_admin_users_picked_up_from_admin_for() -> None:
    """admin_users on each location come from the global admin_for[site]
    list."""
    models = load_models(CONFIG_PATH, site="test", allow_admin_wildcard=True)
    assert "testadmin" in models.location("test").admin_users  # type: ignore[union-attr]
    assert "*" in models.location("test").admin_users  # type: ignore[union-attr]


def test_admin_wildcard_disabled_by_default_fails_closed() -> None:
    # The ["*"] wildcard must NOT take effect unless explicitly allowed, so a
    # pod that booted with a wrong/defaulted site can't grant admin to
    # everyone. The non-wildcard admins on the site are still honoured.
    models = load_models(CONFIG_PATH, site="test")  # allow_admin_wildcard=False
    admins = models.location("test").admin_users  # type: ignore[union-attr]
    assert "*" not in admins
    assert "testadmin" in admins


def test_admin_wildcard_only_site_becomes_no_admins_when_disabled() -> None:
    # A site whose admin_for is purely ["*"] (e.g. base) fails fully closed.
    models = load_models(CONFIG_PATH, site="base")  # allow_admin_wildcard=False
    for loc in models.locations:
        assert loc.admin_users == []


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
        "cameras:\n  - {name: a, title: A, metadata_from: ghost}\nlocations: []\n"
    )
    with pytest.raises(ConfigError, match="metadata_from unknown camera 'ghost'"):
        load_models(bad)


def _models_from(tmp_path: Path, text: str, site: str | None = None) -> Models:
    cfg = tmp_path / "models.yaml"
    cfg.write_text(text)
    return load_models(cfg, site=site)


ONE_CAMERA = (
    "locations:\n  - {name: loc, title: Loc, bucket_name: b, camera_groups: {G: [a]}}\n"
)


def test_legacy_field_spellings_are_accepted(tmp_path: Path) -> None:
    # The YAML carries the old app's spellings: `color` beside `colour`,
    # camelCase extra-button and mosaic fields. The modern spellings load
    # too, and either way the models hold the canonical names.
    models = _models_from(
        tmp_path,
        ONE_CAMERA + "cameras:\n"
        "  - name: a\n"
        "    title: A\n"
        "    channels:\n"
        "      - {name: c1, title: C1, color: '#f00'}\n"
        "      - {name: c2, title: C2, colour: '#0f0'}\n"
        "    extra_buttons:\n"
        "      - {title: M, name: m, linkURL: mosaic}\n"
        "      - {title: N, name: n, link_url: night}\n"
        "    mosaic_view_meta:\n"
        "      - {channel: c1, mediaType: video, metaColumns: [Exposure]}\n"
        "      - {channel: c2}\n",
    )
    cam = models.location("loc").camera("a")  # type: ignore[union-attr]
    assert cam is not None
    assert [c.colour for c in cam.channels] == ["#f00", "#0f0"]
    assert [b.link_url for b in cam.extra_buttons] == ["mosaic", "night"]
    assert [(m.media_type, m.meta_columns) for m in cam.mosaic_view_meta] == [
        ("video", ["Exposure"]),
        ("image", []),
    ]


def test_global_column_maps_skip_names_that_are_not_cameras(tmp_path: Path) -> None:
    # The shared metadata/locked column maps may name cameras another site
    # defines; an unknown name is skipped, not an error.
    models = _models_from(
        tmp_path,
        ONE_CAMERA + "cameras:\n  - {name: a, title: A}\n"
        "metadata_columns:\n  a: {Exposure: seconds}\n  ghost: {X: y}\n"
        "locked_columns:\n  a: [Exposure]\n  ghost: [X]\n",
    )
    cam = models.location("loc").camera("a")  # type: ignore[union-attr]
    assert cam is not None
    assert cam.metadata_columns == {"Exposure": "seconds"}
    assert cam.locked_columns == ["Exposure"]


def test_a_camera_in_two_groups_is_listed_once(tmp_path: Path) -> None:
    models = _models_from(
        tmp_path,
        "locations:\n"
        "  - {name: loc, title: Loc, bucket_name: b,"
        " camera_groups: {G1: [a, b], G2: [b]}}\n"
        "cameras:\n  - {name: a, title: A}\n  - {name: b, title: B}\n",
    )
    assert [c.name for c in models.location("loc").cameras] == ["a", "b"]  # type: ignore[union-attr]


def test_no_site_sees_every_location(tmp_path: Path) -> None:
    # bucket_configurations filters by site only when a site is given.
    text = (
        "locations:\n"
        "  - {name: one, title: One, bucket_name: b1, camera_groups: {}}\n"
        "  - {name: two, title: Two, bucket_name: b2, camera_groups: {}}\n"
        "cameras: []\n"
        "bucket_configurations:\n  here: [one]\n"
    )
    assert {loc.name for loc in _models_from(tmp_path, text).locations} == {
        "one",
        "two",
    }
    assert [loc.name for loc in _models_from(tmp_path, text, "here").locations] == [
        "one"
    ]


def test_explicit_primary_channel_must_be_one_of_the_cameras(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="primary_channel 'ghost'"):
        _models_from(
            tmp_path,
            ONE_CAMERA + "cameras:\n"
            "  - name: a\n"
            "    title: A\n"
            "    primary_channel: ghost\n"
            "    channels: [{name: c1, title: C1}]\n",
        )


def test_admin_menu_items_accept_strings_or_labels(tmp_path: Path) -> None:
    models = _models_from(
        tmp_path,
        "locations: []\ncameras: []\n"
        "admin_redis_menus:\n"
        "  - {title: T, key: K, items: [PLAIN, {label: LABELLED}]}\n",
    )
    assert [i.label for i in models.admin_redis_menus[0].items] == [
        "PLAIN",
        "LABELLED",
    ]
    with pytest.raises(ValueError, match="invalid admin redis menu item"):
        _models_from(
            tmp_path,
            "locations: []\ncameras: []\n"
            "admin_redis_menus:\n  - {title: T, key: K, items: [{nope: 1}]}\n",
        )


@pytest.mark.parametrize(
    ("section", "message"),
    [
        ("metadata_columns:\n  a: [Exposure]\n", "metadata_columns for 'a' must be"),
        ("bucket_configurations:\n  here: one\n", r"bucket_configurations\['here'\]"),
        ("admin_for: [alice]\n", "admin_for must be a mapping"),
    ],
    ids=["metadata-columns", "bucket-configurations", "admin-for"],
)
def test_malformed_top_level_sections_fail_loud(
    tmp_path: Path, section: str, message: str
) -> None:
    text = ONE_CAMERA + "cameras:\n  - {name: a, title: A}\n" + section
    with pytest.raises(ConfigError, match=message):
        _models_from(tmp_path, text)

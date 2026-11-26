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

"""Key parser: conforming keys parse, non-conforming are ignored."""

from __future__ import annotations

from lsst.ts.rubintv.data.parser import (
    parse_channel_event,
    parse_metadata,
    parse_night_report,
)


def test_channel_event() -> None:
    ev = parse_channel_event("lsstcam/2026-04-10/witness_detector/000001/image.png")
    assert ev is not None
    assert ev.camera == "lsstcam"
    assert ev.day_obs == "2026-04-10"
    assert ev.channel == "witness_detector"
    assert ev.seq_num == 1
    assert ev.ext == "png"
    assert ev.is_per_day is False


def test_per_day_event() -> None:
    ev = parse_channel_event("auxtel/2026-04-10/movies/final/movie.mp4")
    assert ev is not None
    assert ev.seq_num == "final"
    assert ev.is_per_day is True


def test_metadata() -> None:
    md = parse_metadata("lsstcam/2026-04-10/metadata.json")
    assert md is not None
    assert md.camera == "lsstcam"
    assert md.day_obs == "2026-04-10"


def test_night_report_text_and_plot() -> None:
    text = parse_night_report("lsstcam/2026-04-10/night_report/summary_md.json")
    assert text is not None and text.is_text is True

    plot = parse_night_report("lsstcam/2026-04-10/night_report/group_a/plot.png")
    assert plot is not None
    assert plot.is_text is False
    assert plot.group == "group_a"


def test_night_report_is_not_a_channel_event() -> None:
    # A night_report plot must not be misparsed as a channel event.
    key = "lsstcam/2026-04-10/night_report/group_a/plot.png"
    assert parse_channel_event(key) is None


def test_non_conforming_keys_ignored() -> None:
    for bad in [
        "garbage",
        "lsstcam/not-a-date/chan/1/f.png",
        "top-level.txt",
        "lsstcam/2026-04-10/",
    ]:
        assert parse_channel_event(bad) is None
        assert parse_metadata(bad) is None
        assert parse_night_report(bad) is None

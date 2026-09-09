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

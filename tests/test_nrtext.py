"""Night-report text normalisation: new typed array + old object format."""

from __future__ import annotations

from lsst.ts.rubintv.data.nrtext import parse_text_items

NEW = "2026-04-10"  # on/after cutoff
OLD = "2025-12-01"  # before cutoff


def _src(day: str) -> str:
    return f"lsstcam/{day}/night_report/summary_md.json"


def test_new_format_all_three_types() -> None:
    raw = [
        {"type": "multiline", "title": "M", "content": "text"},
        {"type": "keyvalues", "title": "K", "content": {"a": "1"}},
        {"type": "links", "title": "L", "content": [{"text": "t", "url": "u"}]},
    ]
    items = parse_text_items(raw, day_obs=NEW, source=_src(NEW))
    assert [i.type for i in items] == ["multiline", "keyvalues", "links"]
    assert items[1].content == {"a": "1"}
    assert items[2].content[0].text == "t"


def test_new_format_drops_invalid_item_but_keeps_rest() -> None:
    raw = [
        {"type": "multiline", "title": "ok", "content": "text"},
        {"type": "keyvalues", "title": "bad", "content": "not-a-dict"},
        {"type": "mystery", "title": "unknown", "content": "x"},
    ]
    items = parse_text_items(raw, day_obs=NEW, source=_src(NEW))
    assert [i.title for i in items] == ["ok"]


def test_old_format_infers_types_by_value_shape() -> None:
    raw = {
        "Summary": "free text",
        "Conditions": {"seeing": "0.8"},
        "Refs": [{"label": "Logbook", "url": "https://x/log"}],
    }
    items = parse_text_items(raw, day_obs=OLD, source=_src(OLD))
    by_title = {i.title: i for i in items}
    assert by_title["Summary"].type == "multiline"
    assert by_title["Summary"].content == "free text"
    assert by_title["Conditions"].type == "keyvalues"
    assert by_title["Conditions"].content == {"seeing": "0.8"}
    # label -> text rename so old links match the new shape.
    refs = by_title["Refs"]
    assert refs.type == "links"
    assert refs.content[0].text == "Logbook"
    assert refs.content[0].url == "https://x/log"
    # The map key is preserved as both key and title.
    assert refs.key == "Refs"


def test_old_format_skips_unrecognised_value() -> None:
    raw = {"weird": 42, "ok": "text"}
    items = parse_text_items(raw, day_obs=OLD, source=_src(OLD))
    assert [i.title for i in items] == ["ok"]


def test_old_format_links_require_label_and_url() -> None:
    # A list whose items lack label/url is not links; it's skipped.
    raw = {"bad": [{"text": "t", "url": "u"}]}
    items = parse_text_items(raw, day_obs=OLD, source=_src(OLD))
    assert items == []


def test_unsupported_top_level_returns_empty() -> None:
    assert parse_text_items("just a string", day_obs=NEW, source=_src(NEW)) == []
    assert parse_text_items(42, day_obs=NEW, source=_src(NEW)) == []


def test_shape_date_mismatch_still_parses() -> None:
    # Shape drives parsing; the date only flags an anomaly. A list dated
    # before the cutoff is still parsed as new-format.
    raw = [{"type": "multiline", "title": "M", "content": "text"}]
    items = parse_text_items(raw, day_obs=OLD, source=_src(OLD))
    assert [i.type for i in items] == ["multiline"]
    # An object dated after the cutoff is still converted as old-format.
    items2 = parse_text_items({"S": "v"}, day_obs=NEW, source=_src(NEW))
    assert items2[0].type == "multiline"
    assert items2[0].content == "v"

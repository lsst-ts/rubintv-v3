"""Normalise night-report text items into one typed shape.

A night-report ``*_md.json`` file holds the night's structured text. Two
on-disk formats exist:

*New* (files written on/after 2026-01-08) — a JSON **array** of typed items::

    [
      {"type": "multiline",  "title": "...", "content": "some text"},
      {"type": "keyvalues",  "title": "...", "content": {"k": "v", ...}},
      {"type": "links",      "title": "...",
       "content": [{"text": "...", "url": "..."}, ...]}
    ]

*Old* (before 2026-01-08) — a JSON **object** whose values' Python types
imply the item type: a string is ``multiline``, a plain object is
``keyvalues``, and a list of ``{label, url}`` is ``links``. The map key
doubles as both ``key`` and ``title``. These are converted to the new
shape here (``label`` is renamed to ``text`` so both paths emit one
consistent links shape).

Format is chosen by JSON *shape* (list -> new, object -> old); the
2026-01-08 cutoff is used only to flag a file whose shape disagrees with
its date, which usually means malformed or hand-edited data.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Literal

from lsst.ts.rubintv.logging import get_logger
from pydantic import BaseModel, Field, TypeAdapter, ValidationError

log = get_logger(__name__)

# Files dated on/after this switched from the old object format to the new
# typed-array format.
NEW_FORMAT_CUTOFF = "2026-01-08"


class LinkItem(BaseModel):
    text: str
    url: str


class MultilineText(BaseModel):
    type: Literal["multiline"]
    title: str
    content: str
    key: str | None = None


class KeyValuesText(BaseModel):
    type: Literal["keyvalues"]
    title: str
    content: dict[str, str]
    key: str | None = None


class LinksText(BaseModel):
    type: Literal["links"]
    title: str
    content: list[LinkItem]
    key: str | None = None


# Discriminated union: ``type`` selects the member, so an unknown/missing
# type or a content shape that doesn't match is a validation error.
NightReportTextItem = Annotated[
    MultilineText | KeyValuesText | LinksText,
    Field(discriminator="type"),
]

_ITEM_ADAPTER: TypeAdapter[NightReportTextItem] = TypeAdapter(NightReportTextItem)


def parse_text_items(
    raw: object, *, day_obs: str, source: str
) -> list[NightReportTextItem]:
    """Parse one ``*_md.json`` payload into typed items.

    ``raw`` is the JSON-decoded body. ``day_obs`` and ``source`` (the object
    key) are used only for diagnostics. Items that fail validation are
    skipped with a warning rather than failing the whole report.
    """
    if isinstance(raw, list):
        if day_obs < NEW_FORMAT_CUTOFF:
            log.warning(
                "nr_text.shape_date_mismatch",
                source=source,
                day_obs=day_obs,
                shape="list",
                expected="object",
            )
        return _validate_items(raw, source=source)
    if isinstance(raw, dict):
        if day_obs >= NEW_FORMAT_CUTOFF:
            log.warning(
                "nr_text.shape_date_mismatch",
                source=source,
                day_obs=day_obs,
                shape="object",
                expected="list",
            )
        return _validate_items(_convert_old(raw, source=source), source=source)
    log.warning("nr_text.unsupported_top_level", source=source, kind=type(raw).__name__)
    return []


def _validate_items(
    items: Sequence[object], *, source: str
) -> list[NightReportTextItem]:
    """Validate each candidate item, skipping (and logging) bad ones."""
    out: list[NightReportTextItem] = []
    for item in items:
        try:
            out.append(_ITEM_ADAPTER.validate_python(item))
        except ValidationError as exc:
            log.warning(
                "nr_text.invalid_item",
                source=source,
                item=item,
                errors=exc.errors(include_url=False, include_input=False),
            )
    return out


def _convert_old(raw: dict[str, object], *, source: str) -> list[dict[str, object]]:
    """Convert the pre-2026-01-08 object format to new-format dicts.

    Item type is inferred from each value's shape; the map key becomes both
    ``key`` and ``title``. Link items rename ``label`` -> ``text`` to match
    the new links shape. Unrecognised values are skipped with a warning.
    """
    converted: list[dict[str, object]] = []
    for key, value in raw.items():
        if isinstance(value, str):
            converted.append(
                {"type": "multiline", "key": key, "title": key, "content": value}
            )
        elif isinstance(value, dict):
            converted.append(
                {"type": "keyvalues", "key": key, "title": key, "content": value}
            )
        elif isinstance(value, list) and all(
            isinstance(item, dict)
            and isinstance(item.get("label"), str)
            and isinstance(item.get("url"), str)
            for item in value
        ):
            converted.append(
                {
                    "type": "links",
                    "key": key,
                    "title": key,
                    "content": [
                        {"text": item["label"], "url": item["url"]} for item in value
                    ],
                }
            )
        else:
            log.warning("nr_text.skip_old_item", source=source, key=key)
    return converted

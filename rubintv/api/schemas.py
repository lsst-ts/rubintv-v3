"""Pydantic response models for the REST API.

These are the typed contract: FastAPI generates the OpenAPI schema from
them, and the frontend generates its TS types from that schema. Keep them
flat and JSON-friendly (sets become sorted lists, etc.).
"""

from __future__ import annotations

from pydantic import BaseModel

from rubintv.data.events import SeqNum


class ChannelOut(BaseModel):
    name: str
    title: str
    label: str
    colour: str | None
    icon: str | None
    per_day: bool


class CameraSummary(BaseModel):
    """Camera as listed under a location (no heavy detail)."""

    name: str
    title: str
    online: bool


class CameraGroupOut(BaseModel):
    label: str
    cameras: list[CameraSummary]


class LocationSummary(BaseModel):
    name: str
    title: str


class LocationOut(BaseModel):
    name: str
    title: str
    camera_groups: list[CameraGroupOut]


class CameraOut(BaseModel):
    """Full camera detail for the camera page header."""

    name: str
    title: str
    online: bool
    channels: list[ChannelOut]
    metadata_columns: dict[str, str]
    image_viewer_link: str | None
    has_mosaic: bool
    has_allsky: bool


class ExtInfoOut(BaseModel):
    default: str | None
    exceptions: dict[str, str]
    """seq_num (as string) -> extension, for the non-default cases."""


class DatePayload(BaseModel):
    """Everything needed to render a camera table for one date."""

    date: str
    channels: dict[str, list[SeqNum]]
    """channel -> sorted seq_nums present (the structured-data index)."""
    extensions: dict[str, ExtInfoOut]
    per_day: dict[str, str]
    """channel -> S3 key of the per-day artifact."""
    metadata: dict[str, dict[str, object]]
    """seq_num (string) -> {column: value}."""
    has_night_report: bool


class CalendarOut(BaseModel):
    dates: list[str]
    """All dates with data, newest first."""


class EventOut(BaseModel):
    key: str
    camera: str
    day_obs: str
    channel: str
    seq_num: SeqNum
    filename: str
    ext: str

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
    text_colour: str | None
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
    logo: str | None = None
    text_colour: str | None = None
    text_shadow: bool = False
    is_teststand: bool = False


class LocationOut(BaseModel):
    name: str
    title: str
    logo: str | None
    text_colour: str | None
    text_shadow: bool
    is_teststand: bool
    has_cluster_status: bool
    services: list[str]
    camera_groups: list[CameraGroupOut]


class TimeSinceClockOut(BaseModel):
    label: str


class ExtraButtonOut(BaseModel):
    title: str
    name: str
    link_url: str
    logo: str | None
    text_colour: str | None


class MosaicViewEntryOut(BaseModel):
    channel: str
    media_type: str
    meta_columns: list[str]


class CameraOut(BaseModel):
    """Full camera detail for the camera page header."""

    name: str
    title: str
    online: bool
    logo: str | None
    text_colour: str | None
    icon: str | None
    channels: list[ChannelOut]
    metadata_columns: dict[str, str]
    image_viewer_link: str | None
    quicklook_viewer_link: str | None
    night_report_label: str | None
    night_report_prefix: str | None
    copy_row_template: str | None
    has_mosaic: bool
    live_view: bool
    """Render this camera as a single 'latest image + latest movie' panel
    rather than a per-seq-num table. The old ``has_allsky`` flag — renamed
    to describe the rendering mode positively and to apply to any camera
    shaped this way, not just All Sky."""
    time_since_clock: TimeSinceClockOut | None
    extra_buttons: list[ExtraButtonOut]
    mosaic_view_meta: list[MosaicViewEntryOut]


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
    has_night_report: bool
    # Metadata is deliberately NOT bundled here. It is a large, slow,
    # live-from-S3 fetch, whereas channels/per_day come from the warm-start
    # cache and render instantly. The table loads metadata separately (the WS
    # stream for progressive fill, the /metadata/{date} endpoint as backstop)
    # so the grid never waits on it.


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

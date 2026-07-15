"""Pydantic response models for the REST API.

These are the typed contract: FastAPI generates the OpenAPI schema from
them, and the frontend generates its TS types from that schema. Keep them
flat and JSON-friendly (sets become sorted lists, etc.).
"""

from __future__ import annotations

from lsst.ts.rubintv.data.events import SeqNum
from pydantic import BaseModel


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
    logo: str | None = None
    """Logo image filename (served from the SPA under ``/logos/``), shown as a
    full-bleed background on the location camera buttons."""
    text_colour: str | None = None
    """CSS colour for the button title, so it stays legible over the logo photo
    (some logos are dark, some light). ``None`` falls back to the theme ink."""
    text_shadow: bool = False
    """Whether to drop a shadow behind the button title (for busy photos)."""
    latest_date: str | None = None
    """Most recent observing day with data (YYYY-MM-DD), or None if the camera
    has no data yet. The client compares it to the current day_obs to show a
    fresh/stale dot."""
    primary_image: str | None = None
    """Proxied media path for the latest frame of the camera's primary channel
    (see ``Camera.primary_channel``), used as the card thumbnail. Relative to
    the API root (``/api/...``), or None when the primary channel has no
    still frame indexed yet."""


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
    has_cluster_status: bool = False
    """Whether this location runs a cluster/detector-status service, so the
    Home page can offer a single 'Cluster status' app when any visible
    location has it."""


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
    locked_columns: list[str]
    image_viewer_link: str | None
    quicklook_viewer_link: str | None
    night_report_label: str | None
    night_report_prefix: str | None
    copy_row_template: str | None
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

    counts: dict[str, int] = {}
    """Per-date exposure count (distinct seq_nums across channels), for the
    date picker's activity overview. Days with no per-seq channels map to 0."""

    max_seq: dict[str, int] = {}
    """Per-date highest integer seq_num, shown in the calendar's month cells.
    Days with no numeric seqs are absent."""

    channel_latest: dict[str, str] = {}
    """Per-channel most recent date with data. Lets the channel grid link a
    card with no frame on the newest date to that channel's last known plot
    instead of a live view that would render nothing."""


class EventOut(BaseModel):
    key: str
    camera: str
    day_obs: str
    channel: str
    seq_num: SeqNum
    filename: str
    ext: str


class DetectorOut(BaseModel):
    """One configured cluster-status stream (site-wide)."""

    key: str
    name: str


class DetectorsConfigOut(BaseModel):
    detectors: list[DetectorOut]


class AdminMenuItemOut(BaseModel):
    label: str


class AdminMenuOut(BaseModel):
    title: str
    key: str
    items: list[AdminMenuItemOut]


class AdminMenusOut(BaseModel):
    menus: list[AdminMenuOut]


class AdminStatusOut(BaseModel):
    """Site-wide admin panel header info."""

    version: str
    git_sha: str
    """Short git hash of the built commit ("unknown" if unavailable)."""
    commit_date: str
    """Commit date of the built commit as YYYY-MM-DD ("unknown" if
    unavailable)."""
    redis_enabled: bool
    cache_enabled: bool
    witness_detector_key: str
    is_admin: bool
    """Whether the requesting user is a site admin (from ``X-Auth-User`` vs
    the deployment's ``admin_users`` list). The frontend uses this to hide
    admin-only controls; the endpoints themselves stay server-gated
    regardless."""


class AdminActionOut(BaseModel):
    """Generic result of an admin action."""

    ok: bool
    detail: str = ""

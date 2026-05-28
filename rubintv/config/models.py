"""Validated domain models for cameras, channels, and locations.

These replace the loose dict parsing of the old ``models_data.yaml``. The
loader (:mod:`rubintv.config.loader`) parses YAML into these models and
fails loudly on bad config (unknown camera references, etc.) at startup.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, model_validator


class Channel(BaseModel):
    """A single data product stream within a camera.

    A channel maps to an S3 path segment; see the key patterns in the design
    doc (``{camera}/{day_obs}/{channel}/{seq}/{file}``).
    """

    name: str
    title: str
    label: str = ""
    colour: str | None = None
    text_colour: str | None = None
    icon: str | None = None
    prefix: str | None = None
    """Optional override of the path segment used in S3 keys for this channel
    (defaults to ``name``). The few legacy channels that store under a
    different segment than their display name use this."""
    per_day: bool = False
    """If true, one artifact per day (e.g. a movie) rather than per-seq-num."""

    @model_validator(mode="after")
    def _default_label(self) -> Channel:
        if not self.label:
            object.__setattr__(self, "label", self.title)
        return self


class MosaicViewEntry(BaseModel):
    """One tile on a camera's mosaic page (a channel rendered as image/video)."""

    channel: str
    media_type: str = "image"
    """``image`` or ``video``; drives the rendered element."""
    meta_columns: list[str] = Field(default_factory=list)


class ExtraButton(BaseModel):
    """An extra navigation button shown on the camera header."""

    title: str
    name: str
    link_url: str
    """Relative URL within the camera (e.g. ``mosaic``)."""
    logo: str | None = None
    text_colour: str | None = None


class TimeSinceClock(BaseModel):
    """A camera-specific 'time since last X' clock shown on the header."""

    label: str


class Camera(BaseModel):
    """A camera/instrument with its channels and metadata columns."""

    name: str
    title: str
    online: bool = True
    logo: str | None = None
    text_colour: str | None = None
    icon: str | None = None
    channels: list[Channel] = Field(default_factory=list)
    metadata_columns: dict[str, str] = Field(default_factory=dict)
    """Column name -> human description, for the metadata table."""
    metadata_from: str | None = None
    """Inherit ``metadata_columns`` from this other camera. Resolved by the
    loader; never observed as non-None on a loaded ``Camera``."""
    image_viewer_link: str | None = None
    quicklook_viewer_link: str | None = None
    night_report_label: str | None = None
    night_report_prefix: str | None = None
    copy_row_template: str | None = None
    """A printf-style template for a 'copy row' admin action — interpolates
    ``{dayObs}`` and ``{seqNum}``."""
    has_mosaic: bool = False
    live_view: bool = False
    """True if this camera shows a single 'latest image + latest movie' panel
    rather than a per-seq-num table. Replaces the old ``has_allsky`` flag —
    it's a positive description of the rendering mode and applies to any
    camera shaped that way, not just All Sky."""
    time_since_clock: TimeSinceClock | None = None
    extra_buttons: list[ExtraButton] = Field(default_factory=list)
    mosaic_view_meta: list[MosaicViewEntry] = Field(default_factory=list)

    def channel(self, name: str) -> Channel | None:
        """Return the named channel, or ``None`` if this camera lacks it."""
        return next((c for c in self.channels if c.name == name), None)


class LocationService(BaseModel):
    """A heartbeat-monitored service declared at a location.

    Locations name the services they expect to be reporting; the top-level
    ``Service`` registry describes what each service *is*.
    """

    name: str


class Location(BaseModel):
    """A deployment-visible location with its cameras, grouped for display."""

    name: str
    title: str
    bucket: str
    profile: str | None = None
    endpoint: str | None = None
    logo: str | None = None
    text_colour: str | None = None
    text_shadow: bool = False
    is_teststand: bool = False
    has_cluster_status: bool = False
    camera_groups: dict[str, list[str]] = Field(default_factory=dict)
    """Group label -> ordered list of camera names."""
    cameras: list[Camera] = Field(default_factory=list)
    """Resolved Camera objects (populated by the loader from camera_groups)."""
    services: list[str] = Field(default_factory=list)
    """Names referencing the top-level service registry."""
    admin_users: list[str] = Field(default_factory=list)
    """Resolved admin usernames (the loader copies these from the global
    ``admin_for`` map, expanding ``*`` to mean 'any authenticated user')."""

    def camera(self, name: str) -> Camera | None:
        """Return the named camera, or ``None`` if not at this location."""
        return next((c for c in self.cameras if c.name == name), None)


class ServiceItem(BaseModel):
    """A sub-service within a service group (e.g. metadata, ISR runner)."""

    name: str
    title: str


class Service(BaseModel):
    """A heartbeat-monitored service group used by the operator UI."""

    name: str
    display_name: str = ""
    channels: str | None = None
    """Camera name whose channel heartbeats are watched alongside this group."""
    services: list[ServiceItem] = Field(default_factory=list)

    @model_validator(mode="after")
    def _default_display(self) -> Service:
        if not self.display_name:
            object.__setattr__(self, "display_name", self.name)
        return self


class RedisDetector(BaseModel):
    """One Redis-backed cluster-status stream observed by the live UI."""

    key: str
    name: str


class AdminRedisMenuItem(BaseModel):
    """A choice within an admin-controlled Redis-backed menu."""

    label: str

    @classmethod
    def from_raw(cls, raw: object) -> AdminRedisMenuItem:
        """Accept either a plain string or a ``{label: ...}`` dict."""
        if isinstance(raw, str):
            return cls(label=raw)
        if isinstance(raw, dict) and "label" in raw:
            return cls(label=str(raw["label"]))
        raise ValueError(f"invalid admin redis menu item: {raw!r}")


class AdminRedisMenu(BaseModel):
    """An admin-controlled Redis-backed selection menu (e.g. AOS pipeline)."""

    title: str
    key: str
    items: list[AdminRedisMenuItem] = Field(default_factory=list)


class Models(BaseModel):
    """The fully-resolved configuration tree loaded from YAML."""

    locations: list[Location] = Field(default_factory=list)
    services: list[Service] = Field(default_factory=list)
    redis_detectors: list[RedisDetector] = Field(default_factory=list)
    admin_redis_menus: list[AdminRedisMenu] = Field(default_factory=list)

    def location(self, name: str) -> Location | None:
        """Return the named location, or ``None``."""
        return next((loc for loc in self.locations if loc.name == name), None)

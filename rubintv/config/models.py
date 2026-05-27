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
    icon: str | None = None
    per_day: bool = False
    """If true, one artifact per day (e.g. a movie) rather than per-seq-num."""

    @model_validator(mode="after")
    def _default_label(self) -> Channel:
        if not self.label:
            object.__setattr__(self, "label", self.title)
        return self


class Camera(BaseModel):
    """A camera/instrument with its channels and metadata columns."""

    name: str
    title: str
    online: bool = True
    channels: list[Channel] = Field(default_factory=list)
    metadata_columns: dict[str, str] = Field(default_factory=dict)
    """Column name -> human description, for the metadata table."""
    image_viewer_link: str | None = None
    has_mosaic: bool = False
    has_allsky: bool = False

    def channel(self, name: str) -> Channel | None:
        """Return the named channel, or ``None`` if this camera lacks it."""
        return next((c for c in self.channels if c.name == name), None)


class Location(BaseModel):
    """A deployment-visible location with its cameras, grouped for display."""

    name: str
    title: str
    bucket: str
    profile: str | None = None
    endpoint: str | None = None
    camera_groups: dict[str, list[str]] = Field(default_factory=dict)
    """Group label -> ordered list of camera names."""
    cameras: list[Camera] = Field(default_factory=list)
    """Resolved Camera objects (populated by the loader from camera_groups)."""
    admin_users: list[str] = Field(default_factory=list)

    def camera(self, name: str) -> Camera | None:
        """Return the named camera, or ``None`` if not at this location."""
        return next((c for c in self.cameras if c.name == name), None)


class Service(BaseModel):
    """A background service definition used for heartbeat monitoring."""

    name: str
    title: str


class Models(BaseModel):
    """The fully-resolved configuration tree loaded from YAML."""

    locations: list[Location] = Field(default_factory=list)
    services: list[Service] = Field(default_factory=list)

    def location(self, name: str) -> Location | None:
        """Return the named location, or ``None``."""
        return next((loc for loc in self.locations if loc.name == name), None)

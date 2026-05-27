"""Load and validate the YAML config into the domain model tree.

This is the one place loose YAML becomes typed, validated models. It fails
loudly — a camera referenced by a location's ``camera_groups`` that has no
definition is a startup error, not a silent ``None`` later.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from rubintv.config.models import Camera, Channel, Location, Models, Service


class ConfigError(ValueError):
    """Raised when the YAML config is structurally invalid."""


def load_models(path: Path) -> Models:
    """Parse and validate the config YAML at ``path`` into :class:`Models`.

    Raises:
        ConfigError: If the file is missing, malformed, or references a
            camera that is not defined.
    """
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")

    try:
        raw: dict[str, Any] = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as exc:  # pragma: no cover - passthrough detail
        raise ConfigError(f"invalid YAML in {path}: {exc}") from exc

    cameras = _parse_cameras(raw.get("cameras", []))
    locations = _parse_locations(raw.get("locations", []), cameras)
    services = [Service.model_validate(s) for s in raw.get("services", [])]

    return Models(locations=locations, services=services)


def _parse_cameras(rows: list[dict[str, Any]]) -> dict[str, Camera]:
    cameras: dict[str, Camera] = {}
    for row in rows:
        channels = [Channel.model_validate(c) for c in row.get("channels", [])]
        camera = Camera.model_validate({**row, "channels": channels})
        if camera.name in cameras:
            raise ConfigError(f"duplicate camera definition: {camera.name}")
        cameras[camera.name] = camera
    return cameras


def _parse_locations(
    rows: list[dict[str, Any]], cameras: dict[str, Camera]
) -> list[Location]:
    locations: list[Location] = []
    for row in rows:
        groups: dict[str, list[str]] = row.get("camera_groups", {})
        resolved: list[Camera] = []
        seen: set[str] = set()
        for group, names in groups.items():
            for name in names:
                if name not in cameras:
                    raise ConfigError(
                        f"location {row.get('name')!r} group {group!r} "
                        f"references unknown camera {name!r}"
                    )
                if name not in seen:
                    resolved.append(cameras[name])
                    seen.add(name)
        location = Location.model_validate({**row, "cameras": resolved})
        locations.append(location)
    return locations

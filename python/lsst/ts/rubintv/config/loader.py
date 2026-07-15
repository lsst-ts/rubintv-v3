"""Load and validate the YAML config into the domain model tree.

This is the one place loose YAML becomes typed, validated models. It fails
loudly — a camera referenced by a location's ``camera_groups`` that has no
definition is a startup error, not a silent ``None`` later.

The YAML supports a top-level ``bucket_configurations`` map keying *sites*
(deployment shapes) to the location names they expose. The loader filters
to the locations belonging to the running site; this is how a `usdf-k8s`
pod sees the four buckets it can reach while a `summit` pod sees only the
summit bucket. An unknown site is a startup error so a typo never silently
yields an empty location list.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from lsst.ts.rubintv.config.models import (
    AdminRedisMenu,
    AdminRedisMenuItem,
    Camera,
    Channel,
    ExtraButton,
    Location,
    Models,
    MosaicViewEntry,
    RedisDetector,
    Service,
    ServiceItem,
    TimeSinceClock,
)
from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)


class ConfigError(ValueError):
    """Raised when the YAML config is structurally invalid."""


def load_models(
    path: Path, *, site: str | None = None, allow_admin_wildcard: bool = False
) -> Models:
    """Parse and validate the config YAML at ``path`` into :class:`Models`.

    Args:
        path: Path to the YAML file.
        site: Optional site name. If the YAML defines a
            ``bucket_configurations`` map, the loaded locations are filtered
            to those exposed to this site. ``None`` means *no filtering*
            (every location in the YAML is loaded); for back-compat with
            configs that don't declare ``bucket_configurations`` this is
            also a no-op.
        allow_admin_wildcard: Whether the ``admin_for: ["*"]`` wildcard (any
            authenticated user is admin) is permitted to take effect. When
            False (the default) a resolved ``["*"]`` admin list is downgraded
            to *no admins* and a warning is logged — so a pod that booted with
            the wrong/defaulted site (``local`` maps to the real USDF
            locations with ``admin_for: local: ["*"]``) fails closed instead of
            granting admin to everyone.

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

    global_metadata = _global_metadata_columns(raw.get("metadata_columns", {}))
    global_locked = _global_locked_columns(raw.get("locked_columns", {}))
    cameras = _parse_cameras(raw.get("cameras", []), global_metadata, global_locked)

    services = _parse_services(raw.get("services", {}))
    admin_for = _parse_admin_for(raw.get("admin_for", {}))
    bucket_configurations = _parse_bucket_configurations(
        raw.get("bucket_configurations", {})
    )

    allowed = _site_locations(bucket_configurations, site)
    location_rows = _filter_location_rows(raw.get("locations", []), allowed)

    locations = _parse_locations(
        location_rows,
        cameras,
        services,
        admin_for,
        site,
        allow_admin_wildcard=allow_admin_wildcard,
    )

    redis_detectors = [
        RedisDetector.model_validate(r) for r in raw.get("redis_detectors", [])
    ]
    admin_redis_menus = _parse_admin_redis_menus(raw.get("admin_redis_menus", []))

    return Models(
        locations=locations,
        services=list(services.values()),
        redis_detectors=redis_detectors,
        admin_redis_menus=admin_redis_menus,
    )


def _global_metadata_columns(
    raw: dict[str, dict[str, str]],
) -> dict[str, dict[str, str]]:
    """Validate the top-level ``metadata_columns`` map keyed by camera name."""
    out: dict[str, dict[str, str]] = {}
    for camera_name, columns in raw.items():
        if not isinstance(columns, dict):
            raise ConfigError(f"metadata_columns for {camera_name!r} must be a mapping")
        # Accept None-valued entries from the legacy YAML; treat them as empty
        # descriptions rather than failing the load.
        out[camera_name] = {
            str(k): (str(v) if v is not None else "") for k, v in columns.items()
        }
    return out


def _global_locked_columns(
    raw: dict[str, list[str]],
) -> dict[str, list[str]]:
    """Validate the top-level ``locked_columns`` map keyed by camera name."""
    out: dict[str, list[str]] = {}
    for camera_name, columns in raw.items():
        if not isinstance(columns, list):
            raise ConfigError(f"locked_columns for {camera_name!r} must be a list")
        out[camera_name] = [str(c) for c in columns]
    return out


def _dedup(items: list[str]) -> list[str]:
    """Order-preserving de-duplication."""
    return list(dict.fromkeys(items))


def _parse_cameras(
    rows: list[dict[str, Any]],
    global_metadata: dict[str, dict[str, str]],
    global_locked: dict[str, list[str]],
) -> dict[str, Camera]:
    cameras: dict[str, Camera] = {}
    for row in rows:
        channels = [_parse_channel(c) for c in row.get("channels", [])]
        body = _normalise_camera(row)
        body["channels"] = channels
        camera = Camera.model_validate(body)
        if camera.name in cameras:
            raise ConfigError(f"duplicate camera definition: {camera.name}")
        cameras[camera.name] = camera

    # Apply top-level metadata_columns (overlays the camera's own definitions).
    for name, columns in global_metadata.items():
        if name not in cameras:
            # The top-level map carries some entries (e.g. service-only names)
            # that don't correspond to a camera — that's fine, just skip.
            continue
        merged = {**cameras[name].metadata_columns, **columns}
        cameras[name] = cameras[name].model_copy(update={"metadata_columns": merged})

    # Apply top-level locked_columns the same way (overlays camera-defined
    # ones). Distinct loop var from the metadata loop above: reusing
    # `columns` would leave mypy joining dict[str, str] with list[str].
    for name, locked in global_locked.items():
        if name not in cameras:
            continue
        merged_locked = _dedup(cameras[name].locked_columns + locked)
        cameras[name] = cameras[name].model_copy(
            update={"locked_columns": merged_locked}
        )

    # Resolve metadata_from inheritance after the global merge so an inheritor
    # picks up the merged columns of its source.
    for name, camera in list(cameras.items()):
        if camera.metadata_from is None:
            continue
        source = cameras.get(camera.metadata_from)
        if source is None:
            raise ConfigError(
                f"camera {name!r} inherits metadata_from unknown camera "
                f"{camera.metadata_from!r}"
            )
        inherited = {**source.metadata_columns, **camera.metadata_columns}
        inherited_locked = _dedup(source.locked_columns + camera.locked_columns)
        cameras[name] = camera.model_copy(
            update={
                "metadata_columns": inherited,
                "locked_columns": inherited_locked,
                "metadata_from": None,
            }
        )

    return cameras


def _parse_channel(row: dict[str, Any]) -> Channel:
    """Normalise a channel row. Accepts ``color`` as a synonym for
    ``colour``."""
    if "color" in row and "colour" not in row:
        row = {**row, "colour": row["color"]}
        row.pop("color", None)
    return Channel.model_validate(row)


def _normalise_camera(row: dict[str, Any]) -> dict[str, Any]:
    """Translate legacy field names to the model's canonical names."""
    body = dict(row)
    body.pop("channels", None)
    if "time_since_clock" in body and isinstance(body["time_since_clock"], dict):
        body["time_since_clock"] = TimeSinceClock.model_validate(
            body["time_since_clock"]
        )
    if "extra_buttons" in body:
        body["extra_buttons"] = [
            _normalise_extra_button(b) for b in body["extra_buttons"]
        ]
    if "mosaic_view_meta" in body:
        body["mosaic_view_meta"] = [
            _normalise_mosaic_entry(m) for m in body["mosaic_view_meta"]
        ]
    return body


def _normalise_extra_button(row: dict[str, Any]) -> ExtraButton:
    body = {**row}
    if "linkURL" in body:
        body["link_url"] = body.pop("linkURL")
    return ExtraButton.model_validate(body)


def _normalise_mosaic_entry(row: dict[str, Any]) -> MosaicViewEntry:
    body = {**row}
    if "mediaType" in body:
        body["media_type"] = body.pop("mediaType")
    if "metaColumns" in body:
        body["meta_columns"] = body.pop("metaColumns")
    return MosaicViewEntry.model_validate(body)


def _parse_bucket_configurations(
    raw: dict[str, Any],
) -> dict[str, list[str]]:
    if not raw:
        return {}
    out: dict[str, list[str]] = {}
    for site, names in raw.items():
        if not isinstance(names, list):
            raise ConfigError(
                f"bucket_configurations[{site!r}] must be a list of location names"
            )
        out[str(site)] = [str(n) for n in names]
    return out


def _site_locations(
    bucket_configurations: dict[str, list[str]], site: str | None
) -> set[str] | None:
    """Return the set of location names visible to ``site``.

    ``None`` means 'no filter' — used when the YAML doesn't declare
    ``bucket_configurations`` at all (back-compat) or when no site is given.
    """
    if not bucket_configurations:
        return None
    if site is None:
        return None
    if site not in bucket_configurations:
        raise ConfigError(
            f"unknown site {site!r}; declared sites: {sorted(bucket_configurations)}"
        )
    return set(bucket_configurations[site])


def _filter_location_rows(
    rows: list[dict[str, Any]], allowed: set[str] | None
) -> list[dict[str, Any]]:
    if allowed is None:
        return rows
    return [r for r in rows if r.get("name") in allowed]


def _parse_locations(
    rows: list[dict[str, Any]],
    cameras: dict[str, Camera],
    services: dict[str, Service],
    admin_for: dict[str, list[str]],
    site: str | None,
    *,
    allow_admin_wildcard: bool = False,
) -> list[Location]:
    locations: list[Location] = []
    site_admins = admin_for.get(site, []) if site else []
    # Fail closed on the "any authenticated user is admin" wildcard unless it
    # was explicitly allowed: a pod that booted with the wrong/defaulted site
    # (local -> real USDF locations, admin_for: ["*"]) must not silently grant
    # admin to everyone. Strip only the wildcard entry — any explicitly named
    # admins for the site are still honoured — and warn loudly.
    if "*" in site_admins and not allow_admin_wildcard:
        log.warning(
            "config.admin_wildcard_disabled",
            site=site,
            detail=(
                "admin_for contains '*' but RUBINTV_ALLOW_ADMIN_WILDCARD is "
                "not set; the wildcard is ignored (named admins still apply). "
                "Set the flag to enable open admin, or set the correct site."
            ),
        )
        site_admins = [u for u in site_admins if u != "*"]
    for row in rows:
        body = _normalise_location(row)
        groups: dict[str, list[str]] = body.get("camera_groups", {}) or {}
        resolved: list[Camera] = []
        seen: set[str] = set()
        for group, names in groups.items():
            for name in names:
                if name not in cameras:
                    raise ConfigError(
                        f"location {body.get('name')!r} group {group!r} "
                        f"references unknown camera {name!r}"
                    )
                if name not in seen:
                    resolved.append(cameras[name])
                    seen.add(name)
        body["cameras"] = resolved

        # Validate per-location service references against the registry.
        for service_name in body.get("services", []):
            if service_name not in services:
                raise ConfigError(
                    f"location {body.get('name')!r} references unknown service "
                    f"{service_name!r}"
                )

        # admin_users: the per-site list from admin_for. ``["*"]`` is a
        # wildcard meaning 'any authenticated user'; preserved verbatim and
        # honoured by the admin gate.
        body["admin_users"] = list(site_admins)

        locations.append(Location.model_validate(body))
    return locations


def _normalise_location(row: dict[str, Any]) -> dict[str, Any]:
    """Map legacy location field names to the model's canonical names."""
    body = dict(row)
    if "profile_name" in body:
        body["profile"] = body.pop("profile_name")
    if "bucket_name" in body:
        body["bucket"] = body.pop("bucket_name")
    if "endpoint_url" in body:
        body["endpoint"] = body.pop("endpoint_url")
    return body


def _parse_services(raw: Any) -> dict[str, Service]:
    """Parse the top-level services registry.

    Accepts either a list of objects (new style) or a mapping of name to body
    (legacy style)."""
    if isinstance(raw, list):
        rows = [dict(r) for r in raw]
    elif isinstance(raw, dict):
        rows = [{"name": name, **(body or {})} for name, body in raw.items()]
    else:
        rows = []
    services: dict[str, Service] = {}
    for row in rows:
        items_raw = row.pop("services", None)
        items: list[ServiceItem] = []
        if isinstance(items_raw, dict):
            items = [
                ServiceItem(name=str(k), title=str(v)) for k, v in items_raw.items()
            ]
        elif isinstance(items_raw, list):
            items = [ServiceItem.model_validate(r) for r in items_raw]
        row["services"] = items
        service = Service.model_validate(row)
        services[service.name] = service
    return services


def _parse_admin_for(raw: Any) -> dict[str, list[str]]:
    if not raw:
        return {}
    if not isinstance(raw, dict):
        raise ConfigError("admin_for must be a mapping of site -> list of users")
    return {str(site): [str(u) for u in users] for site, users in raw.items()}


def _parse_admin_redis_menus(rows: list[dict[str, Any]]) -> list[AdminRedisMenu]:
    out: list[AdminRedisMenu] = []
    for row in rows:
        items = [AdminRedisMenuItem.from_raw(item) for item in row.get("items", [])]
        out.append(
            AdminRedisMenu(
                title=row["title"],
                key=row["key"],
                items=items,
            )
        )
    return out

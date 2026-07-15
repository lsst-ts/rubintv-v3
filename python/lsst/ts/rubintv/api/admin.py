"""Admin control endpoints (Redis-backed in Phase 4).

For now controls are held in an in-memory placeholder so the API shape and
the admin-gating are in place; Phase 4 swaps the backing store for Redis
and wires live readback. Writes are gated on the per-location admin user
list. The authenticated user arrives via a reverse-proxy header
(``X-Auth-User``), matching the embargoed-deployment model.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, status
from lsst.ts.rubintv import __version__
from lsst.ts.rubintv.api.deps import get_app_state, get_location
from lsst.ts.rubintv.api.schemas import (
    AdminActionOut,
    AdminMenuItemOut,
    AdminMenuOut,
    AdminMenusOut,
    AdminStatusOut,
    DetectorOut,
    DetectorsConfigOut,
)
from lsst.ts.rubintv.build_info import commit_date, git_sha, is_release
from lsst.ts.rubintv.config.models import Location
from lsst.ts.rubintv.data.redis_inputs import RedisUnavailable
from lsst.ts.rubintv.logging import get_logger
from lsst.ts.rubintv.state import AppState
from pydantic import BaseModel

log = get_logger(__name__)

router = APIRouter()

# Cluster-set restart keys are derived from the set's status key by swapping
# the CLUSTER_STATUS_ prefix for RUBINTV_CONTROL_RESET_ (matches the original
# app).
_STATUS_PREFIX = "CLUSTER_STATUS_"
_RESET_PREFIX = "RUBINTV_CONTROL_RESET_"


class ControlValue(BaseModel):
    key: str
    value: str


class ControlsOut(BaseModel):
    values: dict[str, str]


def require_admin(
    location: Location = Depends(get_location),
    x_auth_user: str | None = Header(default=None),
) -> str:
    """Ensure the caller is an admin for this location.

    ``"*"`` in ``admin_users`` means *any authenticated user*. This is the
    convention used by open deployments (base/tucson/local) where there is
    no per-user gating.
    """
    if x_auth_user is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "admin access required for this location"
        )
    if "*" in location.admin_users or x_auth_user in location.admin_users:
        return x_auth_user
    raise HTTPException(
        status.HTTP_403_FORBIDDEN, "admin access required for this location"
    )


@router.get("/locations/{location}/admin/controls", response_model=ControlsOut)
def get_controls(
    location: Location = Depends(get_location),
    state: AppState = Depends(get_app_state),
) -> ControlsOut:
    return ControlsOut(values=state.controls.all(location.name))


@router.post("/locations/{location}/admin/controls", response_model=ControlValue)
def set_control(
    body: ControlValue,
    location: Location = Depends(get_location),
    state: AppState = Depends(get_app_state),
    user: str = Depends(require_admin),
) -> ControlValue:
    log.info(
        "admin.control.set_local",
        user=user or "?",
        location=location.name,
        key=body.key,
    )
    state.controls.set(location.name, body.key, body.value)
    return body


# --- Site-wide control / cluster-status config (not per-location) -----------
#
# The Redis ``redis_detectors`` streams and ``admin_redis_menus`` are defined
# at the top level of the config, not under a location, so these endpoints are
# site-wide. Readback values are published under the ``"*"`` key (see
# ``redis_inputs.py``).


@router.get("/admin/controls", response_model=ControlsOut)
def get_site_controls(
    state: AppState = Depends(get_app_state),
) -> ControlsOut:
    return ControlsOut(values=state.controls.all("*"))


@router.get("/admin/menus", response_model=AdminMenusOut)
def get_admin_menus(
    state: AppState = Depends(get_app_state),
) -> AdminMenusOut:
    return AdminMenusOut(
        menus=[
            AdminMenuOut(
                title=menu.title,
                key=menu.key,
                items=[AdminMenuItemOut(label=item.label) for item in menu.items],
            )
            for menu in state.models.admin_redis_menus
        ]
    )


@router.get("/detectors/config", response_model=DetectorsConfigOut)
def get_detectors_config(
    state: AppState = Depends(get_app_state),
) -> DetectorsConfigOut:
    return DetectorsConfigOut(
        detectors=[
            DetectorOut(key=d.key, name=d.name) for d in state.models.redis_detectors
        ]
    )


# --- Site-wide admin actions ------------------------------------------------
#
# The admin page is global (one per deployment). Read endpoints are open; the
# write/destructive actions are gated on the site admin user list. Control
# writes are plain Redis ``SET``s via the RedisInputs manager; the readback
# arrives asynchronously on the admin WS topic, so these return immediately.


def is_site_admin(state: AppState, x_auth_user: str | None) -> bool:
    """Whether ``x_auth_user`` is a site admin (non-raising).

    ``admin_users`` is the same site-wide list on every location (the loader
    copies the site's ``admin_for`` entry), so 'admin for any location' is
    equivalent to 'site admin'. ``"*"`` means any authenticated user.
    """
    if x_auth_user is None:
        return False
    return any(
        "*" in loc.admin_users or x_auth_user in loc.admin_users
        for loc in state.models.locations
    )


def require_site_admin(
    state: AppState = Depends(get_app_state),
    x_auth_user: str | None = Header(default=None),
) -> str:
    """Ensure the caller is an admin for *any* location in this deployment."""
    if not is_site_admin(state, x_auth_user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin access required")
    return x_auth_user or ""


def allowed_control_keys(state: AppState) -> set[str]:
    """The exact Redis keys the admin UI is allowed to write.

    The ``controls/set`` endpoint accepts a caller-supplied key; without a
    bound, an admin (or anything that reached the pod past the auth proxy)
    could ``SET`` any key the analysis cluster consumes, turning the control
    channel into an arbitrary command surface. Constrain writes to the keys
    the config actually defines: the admin menu keys, the witness-detector
    key, the head-node reset key, and the per-set cluster reset keys derived
    from the ``redis_detectors`` status keys (the same derivation
    ``restart_workers`` uses).
    """
    keys = {menu.key for menu in state.models.admin_redis_menus}
    keys.add(state.settings.witness_detector_key)
    keys.add(state.settings.reset_head_node_key)
    for detector in state.models.redis_detectors:
        keys.add(detector.key.replace(_STATUS_PREFIX, _RESET_PREFIX, 1))
    return keys


async def _set_redis(state: AppState, key: str, value: str) -> AdminActionOut:
    """Write one control key, mapping a missing Redis to a 503."""
    if state.redis is None or not state.redis.enabled:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "redis is not configured"
        )
    try:
        await state.redis.set_value(key, value)
    except RedisUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    return AdminActionOut(ok=True, detail=f"set {key}")


@router.get("/admin/status", response_model=AdminStatusOut)
def get_admin_status(
    state: AppState = Depends(get_app_state),
    x_auth_user: str | None = Header(default=None),
) -> AdminStatusOut:
    return AdminStatusOut(
        version=__version__,
        git_sha=git_sha(),
        commit_date=commit_date(),
        is_release=is_release(),
        redis_enabled=state.redis is not None and state.redis.enabled,
        cache_enabled=state.cache_enabled,
        witness_detector_key=state.settings.witness_detector_key,
        is_admin=is_site_admin(state, x_auth_user),
    )


@router.post("/admin/controls/set", response_model=AdminActionOut)
async def set_site_control(
    body: ControlValue,
    state: AppState = Depends(get_app_state),
    user: str = Depends(require_site_admin),
) -> AdminActionOut:
    """Write a control key/value from the admin menu boxes.

    The key must be one the config defines (see ``allowed_control_keys``): an
    unknown key is rejected 400 rather than blindly SET, so this endpoint can't
    be used to write arbitrary keys into the cluster's control namespace.
    """
    allowed = allowed_control_keys(state)
    if body.key not in allowed:
        log.warning("admin.control.rejected", user=user or "?", key=body.key)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"control key not permitted: {body.key}"
        )
    log.info("admin.control.set", user=user or "?", key=body.key)
    return await _set_redis(state, body.key, body.value)


@router.post("/admin/witness-detector", response_model=AdminActionOut)
async def set_witness_detector(
    body: ControlValue,
    state: AppState = Depends(get_app_state),
    _user: str = Depends(require_site_admin),
) -> AdminActionOut:
    """Write the witness-detector value to its configured control key."""
    return await _set_redis(state, state.settings.witness_detector_key, body.value)


@router.post("/admin/reset-head-node", response_model=AdminActionOut)
async def reset_head_node(
    state: AppState = Depends(get_app_state),
    user: str = Depends(require_site_admin),
) -> AdminActionOut:
    """Trigger a head-node reset by writing its sentinel control value."""
    log.warning("admin.reset_head_node", user=user or "?")
    return await _set_redis(
        state,
        state.settings.reset_head_node_key,
        state.settings.reset_head_node_value,
    )


@router.post("/detectors/{set_name}/restart", response_model=AdminActionOut)
async def restart_workers(
    set_name: str,
    state: AppState = Depends(get_app_state),
    user: str = Depends(require_site_admin),
) -> AdminActionOut:
    """Restart a cluster set's workers.

    Resolves the set's status key from ``redis_detectors`` config, derives the
    reset key (``CLUSTER_STATUS_X`` -> ``RUBINTV_CONTROL_RESET_X``) and writes
    the ``reset`` sentinel (matching the original app).
    """
    detector = next(
        (d for d in state.models.redis_detectors if d.name == set_name), None
    )
    if detector is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"unknown detector set: {set_name}"
        )
    reset_key = detector.key.replace(_STATUS_PREFIX, _RESET_PREFIX, 1)
    log.warning("admin.restart_workers", user=user or "?", set=set_name)
    return await _set_redis(state, reset_key, "reset")


@router.post("/admin/flush-historical", response_model=AdminActionOut)
async def flush_historical(
    state: AppState = Depends(get_app_state),
    user: str = Depends(require_site_admin),
) -> AdminActionOut:
    """Clear the disk + in-memory historical cache and trigger a cold
    rescan."""
    if state.flush_historical is None:  # pragma: no cover - always wired
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "flush not available")
    log.warning("admin.flush_historical.request", user=user or "?")
    removed = await state.flush_historical()
    return AdminActionOut(ok=True, detail=f"cleared {removed} cached slices")


@router.post("/admin/flush-redis", response_model=AdminActionOut)
async def flush_redis(
    state: AppState = Depends(get_app_state),
    user: str = Depends(require_site_admin),
) -> AdminActionOut:
    """Danger zone: flush the entire Redis database."""
    log.warning("admin.flush_redis.request", user=user or "?")
    if state.redis is None or not state.redis.enabled:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "redis is not configured"
        )
    try:
        await state.redis.flushdb()
    except RedisUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    return AdminActionOut(ok=True, detail="redis flushed")

"""Admin control endpoints (Redis-backed in Phase 4).

For now controls are held in an in-memory placeholder so the API shape and
the admin-gating are in place; Phase 4 swaps the backing store for Redis
and wires live readback. Writes are gated on the per-location admin user
list. The authenticated user arrives via a reverse-proxy header
(``X-Auth-User``), matching the embargoed-deployment model.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel

from rubintv.api.deps import get_app_state, get_location
from rubintv.config.models import Location
from rubintv.state import AppState

router = APIRouter()


class ControlValue(BaseModel):
    key: str
    value: str


class ControlsOut(BaseModel):
    values: dict[str, str]


def require_admin(
    location: Location = Depends(get_location),
    x_auth_user: str | None = Header(default=None),
) -> str:
    """Ensure the caller is an admin for this location."""
    if x_auth_user is None or x_auth_user not in location.admin_users:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "admin access required for this location"
        )
    return x_auth_user


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
    _user: str = Depends(require_admin),
) -> ControlValue:
    state.controls.set(location.name, body.key, body.value)
    return body

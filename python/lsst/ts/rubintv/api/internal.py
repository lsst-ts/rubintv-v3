# This file is part of rubintv-v3.
#
# Developed for the Vera C. Rubin Observatory Telescope and Site Systems.
# This product includes software developed by the LSST Project
# (https://www.lsst.org).
# See the COPYRIGHT file at the top-level directory of this distribution
# for details of code ownership.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""Pod-local internal endpoints for Rapid Analysis services.

A POST fallback to the ``/internal/heartbeats`` WebSocket (for services that
can't hold a socket), plus a status read for k8s probes and operators. These
are intended to be reachable only from inside the pod — the deployment keeps
``/internal`` off the public ingress; the app does not gate it itself.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from lsst.ts.rubintv.api.deps import get_app_state
from lsst.ts.rubintv.state import AppState
from lsst.ts.rubintv.ws.internal import Heartbeat
from pydantic import BaseModel

# Mounted at /internal (pod-local). Kept separate from the /api router so the
# whole /internal surface can be moved to a NetworkPolicy/port of its own.
internal_router = APIRouter()
# Mounted under /api alongside the other health reads.
status_router = APIRouter()


class ServicesResponse(BaseModel):
    services: dict[str, dict[str, object]]
    """Service name -> ``{"live", "ttl", "age", "location"}``."""


@internal_router.post(
    "/internal/heartbeats",
    status_code=status.HTTP_202_ACCEPTED,
    tags=["internal"],
)
async def post_heartbeat(
    beat: Heartbeat, state: AppState = Depends(get_app_state)
) -> dict[str, str]:
    """Record one liveness beat (fire-and-forget).

    ``async`` on purpose (despite no awaits): the HeartbeatStore and the bus
    queues it publishes to are event-loop-confined — a sync ``def`` would run
    on the threadpool and race the reaper's iteration over the same
    OrderedDict.
    """
    state.heartbeat_svc.record(beat)
    return {"status": "accepted"}


@status_router.get(
    "/health/services",
    response_model=ServicesResponse,
    tags=["health"],
)
async def services(state: AppState = Depends(get_app_state)) -> ServicesResponse:
    """Current liveness of every reporting RA service.

    ``async`` for loop confinement, same as :func:`post_heartbeat`.
    """
    return ServicesResponse(services=state.heartbeats.all())

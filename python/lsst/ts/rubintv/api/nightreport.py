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

"""Night-report endpoints.

Route/internal name stays ``night-report`` (mirrors the S3 prefix); the UI
renders a neutral label. Returns assembled text items + grouped plot keys
for a date. Historical reports are stable; the current day's can update.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends
from lsst.ts.rubintv.api.deps import get_app_state, get_camera, get_location, valid_date
from lsst.ts.rubintv.config.models import Camera, Location
from lsst.ts.rubintv.data.nrtext import NightReportTextItem
from lsst.ts.rubintv.state import AppState
from pydantic import BaseModel

router = APIRouter()


class PlotOut(BaseModel):
    key: str
    group: str
    filename: str


class NightReportOut(BaseModel):
    date: str
    exists: bool
    text: list[NightReportTextItem]
    plots: list[PlotOut]


@router.get(
    "/locations/{location}/cameras/{camera}/night-report/{date}",
    response_model=NightReportOut,
)
async def get_night_report(
    date: str = Depends(valid_date),
    location: Location = Depends(get_location),
    camera: Camera = Depends(get_camera),
    state: AppState = Depends(get_app_state),
) -> NightReportOut:
    idx = state.store.date_index(location.name, camera.name, date)
    if (idx is None or not idx.night_report_keys) and state.backfill_date is not None:
        # A deep-linked historical date may have no indexed night-report keys:
        # either no index at all (cold start before the full sweep reaches it)
        # or an index with structured data but no report yet (the report landed
        # after the last sweep). One bounded on-demand scan of {camera}/{date}/
        # fills the night-report keys (~0.4-1s, one listing). The poller diffs
        # against its last listing, so a re-request for a date that genuinely
        # has no report still lists once but applies nothing. Concurrent
        # requests share the scan. Best-effort: failures fall through to empty.
        await state.backfill_date(location.name, camera.name, date)
        idx = state.store.date_index(location.name, camera.name, date)
    keys = set(idx.night_report_keys) if idx else set()
    if not keys:
        return NightReportOut(date=date, exists=False, text=[], plots=[])
    report = await asyncio.to_thread(state.nightreport.fetch, location.name, keys)
    return NightReportOut(
        date=date,
        exists=True,
        text=report.text,
        plots=[
            PlotOut(key=p.key, group=p.group, filename=p.filename) for p in report.plots
        ],
    )

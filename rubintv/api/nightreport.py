"""Night-report endpoints.

Route/internal name stays ``night-report`` (mirrors the S3 prefix); the UI
renders a neutral label. Returns assembled text items + grouped plot keys
for a date. Historical reports are stable; the current day's can update.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from rubintv.api.deps import get_app_state, get_camera, get_location, valid_date
from rubintv.config.models import Camera, Location
from rubintv.state import AppState

router = APIRouter()


class PlotOut(BaseModel):
    key: str
    group: str
    filename: str


class NightReportOut(BaseModel):
    date: str
    exists: bool
    text: list[dict[str, object]]
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

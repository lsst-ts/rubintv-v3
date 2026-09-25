"""Observing-block guide endpoints.

Thin readers over the ``GuideService`` (blocks per instrument, built from
ConsDB) and the ``BlockNameService`` (program key -> description). When no
ConsDB URL is configured the guide is disabled: ``/guide`` says so and the
block endpoint answers 404 for every instrument, so the SPA can hide the
page rather than show an empty timeline.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from lsst.ts.rubintv.api.deps import get_app_state
from lsst.ts.rubintv.api.schemas import (
    BlockOut,
    GuideBlocksOut,
    GuideConfigOut,
    GuideInstrumentOut,
    ProgramNamesOut,
)
from lsst.ts.rubintv.config.models import Models
from lsst.ts.rubintv.state import AppState

router = APIRouter()

# The observing day rolls over at noon UTC (see data/dayobs.py); the timeline
# draws each day_obs row as the 24 h starting then.
DAY_START_UTC_HOUR = 12

# ConsDB instrument -> the RubinTV camera names that show its exposures, where
# they differ. LATISS is the AuxTel camera; everything else matches by name.
_CAMERA_ALIASES: dict[str, tuple[str, ...]] = {"latiss": ("auxtel", "latiss")}


def _instrument_out(models: Models, name: str) -> GuideInstrumentOut:
    """Pair a ConsDB instrument with the camera that shows its data.

    Camera names match ConsDB instrument names (``lsstcam``) except where
    :data:`_CAMERA_ALIASES` says otherwise (``latiss`` -> ``auxtel``);
    prefer a real observing site over a test stand so the block links
    land on the page observers actually use.
    """
    camera_names = _CAMERA_ALIASES.get(name, (name,))
    hits = [
        (loc, cam)
        for loc in models.locations
        for cam in loc.cameras
        if cam.name in camera_names
    ]
    hits.sort(key=lambda pair: pair[0].is_teststand)
    if not hits:
        return GuideInstrumentOut(
            name=name,
            location=None,
            camera=None,
            image_viewer_link=None,
            quicklook_viewer_link=None,
        )
    loc, cam = hits[0]
    return GuideInstrumentOut(
        name=name,
        location=loc.name,
        camera=cam.name,
        image_viewer_link=cam.image_viewer_link,
        quicklook_viewer_link=cam.quicklook_viewer_link,
    )


@router.get("/guide", response_model=GuideConfigOut)
def guide_config(state: AppState = Depends(get_app_state)) -> GuideConfigOut:
    guide = state.guide
    return GuideConfigOut(
        enabled=guide is not None,
        instruments=[_instrument_out(state.models, n) for n in guide.instruments]
        if guide
        else [],
        day_start_utc_hour=DAY_START_UTC_HOUR,
        max_gap_minutes=state.settings.guide_max_gap_minutes,
    )


@router.get("/guide/programs", response_model=ProgramNamesOut)
def program_names(state: AppState = Depends(get_app_state)) -> ProgramNamesOut:
    names = state.block_names
    return ProgramNamesOut(
        names=names.names,
        source=names.source,
        updated_at=names.updated_at,
        error=names.error,
    )


@router.get("/guide/{instrument}/blocks", response_model=GuideBlocksOut)
def guide_blocks(
    instrument: str, state: AppState = Depends(get_app_state)
) -> GuideBlocksOut:
    guide = state.guide.get(instrument) if state.guide else None
    if guide is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"no guide for instrument: {instrument}"
        )
    return GuideBlocksOut(
        instrument=instrument,
        blocks=[BlockOut(**b.to_dict()) for b in guide.blocks()],
        loading=not guide.swept,
        updated_at=guide.updated_at,
        last_exposure_id=guide.last_exposure_id,
        exposures=guide.exposures_seen,
        error=guide.error,
    )

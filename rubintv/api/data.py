"""Core data endpoints — thin readers over the EventStore.

Handlers format what the store already holds; no S3 access here (the proxy
is separate). Path params are validated by the deps (unknown -> 404).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from rubintv.api.deps import (
    get_app_state,
    get_camera,
    get_location,
    get_models,
    valid_date,
)
from rubintv.api.schemas import (
    CalendarOut,
    CameraGroupOut,
    CameraOut,
    CameraSummary,
    ChannelOut,
    DatePayload,
    EventOut,
    ExtInfoOut,
    ExtraButtonOut,
    LocationOut,
    LocationSummary,
    MosaicViewEntryOut,
    TimeSinceClockOut,
)
from rubintv.config.models import Camera, Location, Models
from rubintv.data.parser import parse_channel_event
from rubintv.state import AppState

router = APIRouter()


@router.get("/locations", response_model=list[LocationSummary])
def list_locations(models: Models = Depends(get_models)) -> list[LocationSummary]:
    return [
        LocationSummary(
            name=loc.name,
            title=loc.title,
            logo=loc.logo,
            text_colour=loc.text_colour,
            text_shadow=loc.text_shadow,
            is_teststand=loc.is_teststand,
        )
        for loc in models.locations
    ]


@router.get("/locations/{location}", response_model=LocationOut)
def get_location_detail(location: Location = Depends(get_location)) -> LocationOut:
    groups = [
        CameraGroupOut(
            label=label,
            cameras=[
                CameraSummary(name=c.name, title=c.title, online=c.online)
                for name in names
                if (c := location.camera(name)) is not None
            ],
        )
        for label, names in location.camera_groups.items()
    ]
    return LocationOut(
        name=location.name,
        title=location.title,
        logo=location.logo,
        text_colour=location.text_colour,
        text_shadow=location.text_shadow,
        is_teststand=location.is_teststand,
        has_cluster_status=location.has_cluster_status,
        services=location.services,
        camera_groups=groups,
    )


@router.get("/locations/{location}/cameras/{camera}", response_model=CameraOut)
def get_camera_detail(camera: Camera = Depends(get_camera)) -> CameraOut:
    return CameraOut(
        name=camera.name,
        title=camera.title,
        online=camera.online,
        logo=camera.logo,
        text_colour=camera.text_colour,
        icon=camera.icon,
        channels=[
            ChannelOut(
                name=ch.name,
                title=ch.title,
                label=ch.label,
                colour=ch.colour,
                text_colour=ch.text_colour,
                icon=ch.icon,
                per_day=ch.per_day,
            )
            for ch in camera.channels
        ],
        metadata_columns=camera.metadata_columns,
        image_viewer_link=camera.image_viewer_link,
        quicklook_viewer_link=camera.quicklook_viewer_link,
        night_report_label=camera.night_report_label,
        night_report_prefix=camera.night_report_prefix,
        copy_row_template=camera.copy_row_template,
        has_mosaic=camera.has_mosaic,
        live_view=camera.live_view,
        time_since_clock=(
            TimeSinceClockOut(label=camera.time_since_clock.label)
            if camera.time_since_clock
            else None
        ),
        extra_buttons=[
            ExtraButtonOut(
                title=b.title,
                name=b.name,
                link_url=b.link_url,
                logo=b.logo,
                text_colour=b.text_colour,
            )
            for b in camera.extra_buttons
        ],
        mosaic_view_meta=[
            MosaicViewEntryOut(
                channel=m.channel,
                media_type=m.media_type,
                meta_columns=m.meta_columns,
            )
            for m in camera.mosaic_view_meta
        ],
    )


@router.get(
    "/locations/{location}/cameras/{camera}/calendar", response_model=CalendarOut
)
def get_calendar(
    location: Location = Depends(get_location),
    camera: Camera = Depends(get_camera),
    state: AppState = Depends(get_app_state),
) -> CalendarOut:
    return CalendarOut(dates=state.store.calendar(location.name, camera.name))


@router.get(
    "/locations/{location}/cameras/{camera}/dates/{date}",
    response_model=DatePayload,
)
async def get_date_payload(
    date: str = Depends(valid_date),
    location: Location = Depends(get_location),
    camera: Camera = Depends(get_camera),
    state: AppState = Depends(get_app_state),
) -> DatePayload:
    idx = state.store.date_index(location.name, camera.name, date)
    metadata = await state.metadata.get(location.name, camera.name, date)
    if idx is None:
        # A date with no structured data may still have metadata; return an
        # empty-but-valid payload rather than 404 so the table can render.
        return DatePayload(
            date=date,
            channels={},
            extensions={},
            per_day={},
            metadata=metadata,
            has_night_report=False,
        )
    return DatePayload(
        date=date,
        channels={ch: sorted(seqs, key=str) for ch, seqs in idx.channels.items()},
        extensions={
            ch: ExtInfoOut(
                default=e.default,
                exceptions={str(k): v for k, v in e.exceptions.items()},
            )
            for ch, e in idx.extensions.items()
        },
        per_day=idx.per_day,
        metadata=metadata,
        has_night_report=bool(idx.night_report_keys),
    )


@router.get(
    "/locations/{location}/cameras/{camera}/metadata/{date}",
    response_model=dict[str, dict[str, object]],
)
async def get_metadata(
    date: str = Depends(valid_date),
    location: Location = Depends(get_location),
    camera: Camera = Depends(get_camera),
    state: AppState = Depends(get_app_state),
) -> dict[str, dict[str, object]]:
    return await state.metadata.get(location.name, camera.name, date)


@router.get("/locations/{location}/cameras/{camera}/events", response_model=EventOut)
def get_event_by_key(
    key: str,
    camera: Camera = Depends(get_camera),
) -> EventOut:
    """Resolve a specific event by its S3 key (validated by the parser)."""
    ev = parse_channel_event(key)
    if ev is None or ev.camera != camera.name:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no event for key: {key}")
    return EventOut(
        key=ev.key,
        camera=ev.camera,
        day_obs=ev.day_obs,
        channel=ev.channel,
        seq_num=ev.seq_num,
        filename=ev.filename,
        ext=ev.ext,
    )

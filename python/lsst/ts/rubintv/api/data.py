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

"""Core data endpoints — thin readers over the EventStore.

Handlers format what the store already holds; the only S3 touch is the
date-payload backfill, which asks the poll engine to scan a single missing
date on demand (the proxy is separate). Path params are validated by the
deps (unknown -> 404).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from lsst.ts.rubintv.api.deps import (
    get_app_state,
    get_camera,
    get_location,
    get_models,
    valid_date,
)
from lsst.ts.rubintv.api.schemas import (
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
    MetadataChangesOut,
    MosaicViewEntryOut,
    PerDayOut,
    TimeSinceClockOut,
)
from lsst.ts.rubintv.config.models import Camera, Location, Models
from lsst.ts.rubintv.data.metadata import MetadataDoc, MetadataUnavailable
from lsst.ts.rubintv.data.parser import parse_channel_event
from lsst.ts.rubintv.middleware import accepts_gzip
from lsst.ts.rubintv.state import AppState

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
            has_cluster_status=loc.has_cluster_status,
        )
        for loc in models.locations
    ]


def _primary_image_path(state: AppState, location: str, camera: Camera) -> str | None:
    """Proxied media path for the latest frame of ``camera``'s primary channel.

    Mirrors the proxy route and the frontend's ``mediaUrl`` (channel *name* in
    the URL, seq zero-padded to 6, ``image.{ext}`` filename). Returned relative
    to the API root — the client prefixes its base. ``None`` when the camera
    has no primary channel or that channel has no still frame indexed.
    """
    if camera.primary_channel is None:
        return None
    latest = state.store.latest_channel_image(
        location, camera.name, camera.primary_channel
    )
    if latest is None:
        return None
    date, seq, ext = latest
    return (
        f"/locations/{location}/cameras/{camera.name}/channels/"
        f"{camera.primary_channel}/{date}/{seq:06d}/image.{ext}"
    )


@router.get("/locations/{location}", response_model=LocationOut)
async def get_location_detail(
    location: Location = Depends(get_location),
    state: AppState = Depends(get_app_state),
) -> LocationOut:
    # ``async`` on purpose (despite no awaits): the store reads below iterate
    # live index dicts that the pollers mutate on the event loop. A sync
    # ``def`` runs on the threadpool, where a mid-iteration mutation raises
    # "dict changed size during iteration"; loop confinement makes the reads
    # atomic with respect to ``store.apply``.
    groups = [
        CameraGroupOut(
            label=label,
            cameras=[
                CameraSummary(
                    name=c.name,
                    title=c.title,
                    online=c.online,
                    logo=c.logo,
                    text_colour=c.text_colour,
                    text_shadow=c.text_shadow,
                    latest_date=state.store.latest_date(location.name, c.name),
                    primary_image=_primary_image_path(state, location.name, c),
                )
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
        camera_groups=groups,
    )


@router.get("/locations/{location}/cameras/{camera}", response_model=CameraOut)
async def get_camera_detail(camera: Camera = Depends(get_camera)) -> CameraOut:
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
        locked_columns=camera.locked_columns,
        image_viewer_link=camera.image_viewer_link,
        quicklook_viewer_link=camera.quicklook_viewer_link,
        night_report_label=camera.night_report_label,
        night_report_prefix=camera.night_report_prefix,
        copy_row_template=camera.copy_row_template,
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
async def get_calendar(
    location: Location = Depends(get_location),
    camera: Camera = Depends(get_camera),
    state: AppState = Depends(get_app_state),
) -> CalendarOut:
    # ``async`` for loop confinement, same as ``get_location_detail``: the
    # calendar_* reads iterate live index dicts the pollers mutate.
    return CalendarOut(
        dates=state.store.calendar(location.name, camera.name),
        counts=state.store.calendar_counts(location.name, camera.name),
        max_seq=state.store.calendar_max_seq(location.name, camera.name),
        channel_latest=state.store.calendar_channel_latest(location.name, camera.name),
        per_day_dates=state.store.calendar_per_day_dates(location.name, camera.name),
    )


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
    # Reads the in-memory store (warm-start cached), so the grid renders
    # immediately. Metadata is fetched separately by the client (from
    # /metadata/{date}/changes).
    idx = state.store.date_index(location.name, camera.name, date)
    if idx is None and state.backfill_date is not None:
        # A deep-linked date can be real but unindexed (cold start before the
        # full sweep, or data landed since the last 12h refresh). One bounded
        # on-demand scan of {camera}/{date}/ fills it — ~0.4-1s, deduped per
        # date by the engine, best-effort (failures fall through to the empty
        # payload below).
        await state.backfill_date(location.name, camera.name, date)
        idx = state.store.date_index(location.name, camera.name, date)
    if idx is None:
        # A date may still have metadata (fetched separately) with no
        # structured data; return an empty-but-valid payload rather than 404
        # so the table can still render its metadata rows.
        return DatePayload(
            date=date,
            channels={},
            extensions={},
            per_day={},
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
        per_day={
            ch: PerDayOut(seq=ref.seq, ext=ref.ext) for ch, ref in idx.per_day.items()
        },
        has_night_report=bool(idx.night_report_keys),
    )


async def _metadata(
    state: AppState, location: Location, camera: Camera, date: str
) -> MetadataDoc:
    """The date's current metadata, or a 503 while it can't be read."""
    try:
        return await state.metadata.get(location.name, camera.name, date)
    except MetadataUnavailable as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"metadata for {camera.name} {date} is unavailable",
        ) from exc


@router.get(
    "/locations/{location}/cameras/{camera}/metadata/{date}",
    response_model=dict[str, dict[str, object]],
)
async def get_metadata(
    date: str = Depends(valid_date),
    location: Location = Depends(get_location),
    camera: Camera = Depends(get_camera),
    state: AppState = Depends(get_app_state),
    if_none_match: str | None = Header(default=None),
) -> Response:
    """The whole metadata document for a date (seq_num -> row).

    The page itself reads ``/changes`` below, which can send just what
    changed; this is the plain document for anything else.
    """
    doc = await _metadata(state, location, camera, date)
    headers = {"ETag": doc.etag} if doc.etag is not None else {}
    if doc.etag is not None and if_none_match == doc.etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    # The cached text as it is: a Response skips the validation and
    # serialisation of the response model, which for a 17 MiB night held the
    # event loop for about 0.1 s.
    return Response(doc.body, media_type="application/json", headers=headers)


@router.get(
    "/locations/{location}/cameras/{camera}/metadata/{date}/changes",
    response_model=MetadataChangesOut,
)
async def get_metadata_changes(
    request: Request,
    since: str | None = None,
    date: str = Depends(valid_date),
    location: Location = Depends(get_location),
    camera: Camera = Depends(get_camera),
    state: AppState = Depends(get_app_state),
) -> Response | MetadataChangesOut:
    """A date's metadata as the changes since version ``since``.

    The one way the page loads metadata: with no ``since`` (or one the
    server can't diff from) the reply is the whole document, otherwise the
    rows that changed. A WebSocket ``metadata`` message says when to ask
    again.
    """
    doc = await _metadata(state, location, camera, date)
    delta = doc.changes_since(since)
    if delta is not None:
        return MetadataChangesOut(
            etag=delta.etag, since=delta.since, rows=delta.rows, removed=delta.removed
        )
    # Built around the cached text, for the reason given in get_metadata,
    # and sent from a compressed copy kept with it: every page that opens a
    # night gets this reply, and compressing a large one afresh each time
    # cost more than fetching it.
    if doc.etag is not None and accepts_gzip(request.headers):
        return Response(
            await state.metadata.gzipped(location.name, camera.name, date, doc),
            media_type="application/json",
            headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"},
        )
    return Response(doc.whole(), media_type="application/json")


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

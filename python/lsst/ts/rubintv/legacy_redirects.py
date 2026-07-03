"""Redirect legacy deep links to the equivalent new-app SPA URLs.

The previous app (lsst-ts/rubintv) served server-rendered pages whose URL
*shape* differs from this rebuild's client-side routes: dates and channels
lived in path segments, the Channels/Current segment order was reversed,
cluster-status carried a location the new app dropped, and single events were
addressed by a ``type``/``visit`` (or ``key``) query contract rather than
``?date=&seq=``.

Both apps are served under the same path prefix (``/rubintv`` by default), so
these redirects translate URL *shape* within that prefix — old links keep the
prefix and only their tail changes. The routes are registered before the SPA
catch-all (which would otherwise swallow the old shapes into a broken client
route) and after ``/api``/``/ws``, so they intercept only the legacy shapes.

Mapping (paths shown relative to the shared prefix P, e.g. P=/rubintv):

    P/admin                                -> P/admin (passthrough)
    P/slac[/...]                           -> P/usdf[/...] (alias, 1st hop)
    P/{loc}/cluster-status                 -> P/detectors (loc dropped)
    P/{loc}/{cam}/date/{date}              -> P/{loc}/{cam}?date={date}
    P/{loc}/{cam}/date/historical          -> P/{loc}/{cam}
    P/{loc}/{cam}/historical               -> P/{loc}/{cam}
    P/{loc}/{cam}/night_report             -> P/{loc}/{cam}/night-report
    P/{loc}/{cam}/night_report/{date}
        -> P/{loc}/{cam}/night-report?date={date}
        -> P/{loc}/{cam}/night-report?date={date}
    P/{loc}/{cam}/current/{channel}        -> P/{loc}/{cam}/{channel}/current
    P/{loc}/{cam}/event?type=&visit=&ext=  -> P/{loc}/{cam}/{type}?date=&seq=
    P/{loc}/{cam}/event?channel_name=&date_str=&seq_num=
        -> P/{loc}/{cam}/{channel}?date=&seq=
    P/{loc}/{cam}/event?key=<s3 key>
        -> P/{loc}/{cam}/{channel}?date=&seq=
        -> P/{loc}/{cam}/{channel}?date=&seq=

Endpoints whose old and new shapes are identical (``P/``, ``P/{loc}``,
``P/{loc}/{cam}``, ``P/{loc}/{cam}/mosaic``) need no redirect — the SPA
catch-all already serves them. Only the shapes that actually differ are
registered here.

``/slac`` is the old alias for the ``usdf`` location; it redirects in two hops
— first swapping the segment to the equivalent ``/usdf/...`` legacy URL (same
shape, query intact), which then falls through to the handlers below for the
second hop to the SPA route. Keeping it a plain alias (rather than duplicating
the shape mapping) means the whole ``/slac`` block can be removed in one piece
if it's confirmed no links still use it.

The ``?seq_num=`` highlight list on the camera/date pages carries over to the
new table's ``?seq_filter=`` (both are comma/range seq selectors on that view).
"""

from __future__ import annotations

from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)


def build_router(prefix: str) -> APIRouter:
    """Build the legacy-redirect router mounted under ``prefix``.

    ``prefix`` is the app-wide path prefix (e.g. ``/rubintv``) with no trailing
    slash; redirect targets are built relative to it so old and new links share
    the prefix.
    """
    router = APIRouter(prefix=prefix, include_in_schema=False)

    def to(path: str, query: dict[str, str] | None = None) -> RedirectResponse:
        """301 to ``{prefix}{path}``, appending non-empty query params."""
        url = f"{prefix}{path}"
        if query:
            pairs = {k: v for k, v in query.items() if v}
            if pairs:
                url = f"{url}?{urlencode(pairs)}"
        return RedirectResponse(url=url, status_code=301)

    @router.get("/admin")
    async def legacy_admin() -> RedirectResponse:
        return to("/admin")

    @router.get("/slac")
    async def legacy_slac_root() -> RedirectResponse:
        # The old app 301'd /slac -> /usdf; preserve the alias.
        return to("/usdf")

    @router.get("/slac/{rest:path}")
    async def legacy_slac(rest: str, request: Request) -> RedirectResponse:
        # Two-hop: /slac is just the old alias for the /usdf location, so swap
        # the segment and 301 to the equivalent /usdf legacy URL (same shape,
        # query string intact). That lands on the real legacy handlers above,
        # which do the second hop to the new SPA route. Keeping this a plain
        # alias — rather than re-implementing the shape mapping here — means
        # the whole /slac block can be deleted in one piece once no links
        # use it.
        url = f"{prefix}/usdf/{rest}"
        if request.url.query:
            url = f"{url}?{request.url.query}"
        return RedirectResponse(url=url, status_code=301)

    # --- The event endpoint: key OR type/visit OR the split form. ---

    @router.get("/{location}/{camera}/event")
    async def legacy_event(
        location: str,
        camera: str,
        key: str | None = None,
        channel_name: str | None = None,
        date_str: str | None = None,
        seq_num: int | None = None,
        ext: str | None = None,
        type: str | None = None,
        visit: str | None = None,
    ) -> RedirectResponse:
        """Resolve any old event-addressing form to ``{channel}?date=&seq=``.

        Precedence matches the old handler: an explicit ``key`` wins, then the
        split ``channel_name/date_str/seq_num`` form, then ``type``/``visit``.
        """
        try:
            if key is not None:
                channel, date_out, seq = _from_key(key)
            elif (
                channel_name is not None
                and date_str is not None
                and seq_num is not None
            ):
                channel, date_out, seq = channel_name, date_str, str(seq_num)
            elif type is not None and visit is not None:
                date_out, seq = _from_visit(visit)
                channel = type
            else:
                raise HTTPException(status_code=404, detail="Event not addressable.")
        except (ValueError, IndexError) as exc:
            raise HTTPException(
                status_code=404, detail="Malformed event link."
            ) from exc
        return to(f"/{location}/{camera}/{channel}", {"date": date_out, "seq": seq})

    # --- Fixed-shape sub-pages. Specific routes before generic ones. ---

    @router.get("/{location}/cluster-status")
    async def legacy_cluster_status(location: str) -> RedirectResponse:
        # Cluster status is deployment-wide in the new app; the per-location
        # segment is discarded.
        return to("/detectors")

    @router.get("/{location}/{camera}/historical")
    async def legacy_historical(location: str, camera: str) -> RedirectResponse:
        # Old app redirected this to date/historical, i.e. "newest with data",
        # which the bare camera route already resolves to.
        return to(f"/{location}/{camera}")

    @router.get("/{location}/{camera}/date/{date_str}")
    async def legacy_camera_for_date(
        location: str, camera: str, date_str: str, seq_num: str | None = None
    ) -> RedirectResponse:
        # "historical" sentinel means newest-with-data; drop it so the new
        # route resolves it. A real date moves from path segment to ?date=.
        query = _seq_filter(seq_num)
        if date_str != "historical":
            query["date"] = date_str
        return to(f"/{location}/{camera}", query)

    @router.get("/{location}/{camera}/night_report/{date_str}")
    async def legacy_night_report_date(
        location: str, camera: str, date_str: str
    ) -> RedirectResponse:
        return to(f"/{location}/{camera}/night-report", {"date": date_str})

    @router.get("/{location}/{camera}/night_report")
    async def legacy_night_report(location: str, camera: str) -> RedirectResponse:
        return to(f"/{location}/{camera}/night-report")

    @router.get("/{location}/{camera}/current/{channel}")
    async def legacy_current(
        location: str, camera: str, channel: str
    ) -> RedirectResponse:
        # Segment order reversed: current/{channel} -> {channel}/current.
        return to(f"/{location}/{camera}/{channel}/current")

    return router


# --- Pure decode helpers (no router/prefix state). ---


def _seq_filter(seq_num: str | None) -> dict[str, str]:
    """Old ``?seq_num=`` highlight list -> new ``?seq_filter=``
    (passthrough)."""
    return {"seq_filter": seq_num} if seq_num else {}


def _from_visit(visit: str) -> tuple[str, str]:
    """Decode a ``visit`` composite into ``(date, seq)``.

    ``visit`` is ``YYYYMMDD`` + zero-padded seq (the old encoder padded to 5,
    but its decoder used ``int()``, so any padding is tolerated). Mirrors the
    old ``get_key_from_type_and_visit``: ``day_obs = visit[:8]``,
    ``seq = int(visit[8:])``.
    """
    day = visit[:8]
    date_str = f"{day[:4]}-{day[4:6]}-{day[6:8]}"
    seq = str(int(visit[8:]))  # strips leading zeros; raises on non-numeric
    return date_str, seq


def _from_key(key: str) -> tuple[str, str, str]:
    """Decode a raw bucket ``key`` into ``(channel, date, seq)``.

    Keys look like
    ``{camera}/{date}/{channel}/{seq}/{camera}_{channel}_{date}_{seq}(.ext)``.
    The leading four segments carry everything the new URL needs; ``seq`` is
    stripped of zero-padding.
    """
    parts = key.split("/")
    if len(parts) < 4:
        raise ValueError(f"unrecognised event key: {key!r}")
    _camera, date_str, channel, seq = parts[:4]
    return channel, date_str, str(int(seq))

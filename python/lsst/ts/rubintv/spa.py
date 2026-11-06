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

"""Serve the built SPA with a deep-link catch-all.

In production the React build (``web/dist``) is served by FastAPI: hashed
assets under ``/assets`` with long cache lifetimes, and a catch-all that
returns ``index.html`` for any non-API path so client-side deep links
survive a hard reload (the multi-tab guarantee, Decision 7).

Registered last, so it never shadows ``/api``, ``/ws``, or sub-app mounts.
If the build directory is absent (dev, where Vite serves the SPA), the
catch-all is not installed.

One image serves every deployment, whatever its prefix, so the build can't
know where it lives: Vite builds with a relative base (``./``) and
``index.html`` is rewritten as it is served (:func:`render_index`).
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)

# A src/href in the built index.html that is relative to the page (Vite's
# "./" base). Only index.html needs rewriting: the bundle resolves its own
# chunk and asset URLs against import.meta.url, and CSS url()s against the
# stylesheet.
_PAGE_RELATIVE_URL = re.compile(r'(\s(?:src|href)=")\./')

# The element the SPA reads its deployment facts from (web/src/lib/
# deployment.ts). A JSON data block, not a script: it never executes.
DEPLOYMENT_ELEMENT_ID = "rubintv-deployment"


def render_index(page: str, prefix: str, instance_env: str) -> str:
    """Fit the built ``index.html`` to this deployment.

    Two changes. Page-relative ``./`` URLs become absolute ``{prefix}/``
    ones: a deep link such as ``{prefix}/summit/lsstcam`` would otherwise
    send ``./assets/…`` to ``{prefix}/summit/assets/…``. And a JSON block
    before ``</head>`` gives the SPA its prefix (the router basename, and the
    root of every fetch and WebSocket URL) and the instance env (the dev
    strip, ``{dev}`` link templates) before it renders.
    """
    rooted = html.escape(prefix, quote=True)
    page = _PAGE_RELATIVE_URL.sub(lambda m: f"{m.group(1)}{rooted}/", page)
    # "<" escaped so no value can close the element early.
    data = json.dumps({"prefix": prefix, "env": instance_env}).replace("<", "\\u003c")
    block = (
        f'<script id="{DEPLOYMENT_ELEMENT_ID}" type="application/json">{data}</script>'
    )
    if "</head>" not in page:
        # Vite always emits a <head>. Without the block the SPA falls back to
        # the build's "./" base and can't route, so say why.
        log.warning("spa.index_without_head", reason="deployment block not added")
        return page
    return page.replace("</head>", f"{block}</head>", 1)


def mount_spa(
    app: FastAPI,
    dist_dir: Path | None,
    prefix: str = "",
    instance_env: str = "prod",
) -> bool:
    """Serve the SPA from ``dist_dir``; returns True if mounted.

    The app is served beneath ``prefix`` (e.g. ``/rubintv``), so the catch-all
    and the hashed-asset mount live there too, and ``index.html`` is rendered
    once here to request its assets at ``{prefix}/assets`` and to tell the SPA
    its prefix and ``instance_env``.
    """
    if dist_dir is None or not (dist_dir / "index.html").is_file():
        log.info("spa.skip", reason="no build directory", dir=str(dist_dir))
        return False

    index = render_index(
        (dist_dir / "index.html").read_text(encoding="utf-8"), prefix, instance_env
    )
    assets = dist_dir / "assets"
    if assets.is_dir():
        app.mount(f"{prefix}/assets", StaticFiles(directory=assets), name="assets")

    # index.html must NOT be heuristically cached by the browser: the :deploy
    # image tag is mutable, so after a repush the hashed bundle filenames
    # change. A stale cached index would request the previous build's bundles
    # (now 404) and the page would break until a hard refresh. no-cache forces
    # revalidation so a new deploy is picked up. (The hashed /assets are
    # content-addressed and safe for the browser to keep.)
    def _index_response() -> HTMLResponse:
        return HTMLResponse(index, headers={"Cache-Control": "no-cache"})

    # A visit to the bare prefix (e.g. /rubintv) must also serve the SPA; the
    # catch-all below only matches paths *under* the prefix.
    if prefix:

        @app.get(prefix, include_in_schema=False)
        def spa_root() -> HTMLResponse:
            return _index_response()

    @app.get(f"{prefix}/{{full_path:path}}", include_in_schema=False)
    def spa_catch_all(full_path: str) -> Response:
        # API/WS/sub-app routes are registered before this and take
        # precedence; anything reaching here that looks like an API call is
        # a genuine 404, not an SPA route. full_path is relative to the prefix,
        # so these leading segments match regardless of the prefix.
        if full_path.startswith(("api/", "ws", "ddv", "exp_checker", "internal")):
            raise HTTPException(status_code=404)
        # Vite copies web/public/* verbatim into the dist root (logos,
        # rubin-mark.png), so a path naming a real file is a static asset,
        # not an SPA route. resolve() + is_relative_to guards traversal.
        candidate = (dist_dir / full_path).resolve()
        if candidate.is_file() and candidate.is_relative_to(dist_dir.resolve()):
            return FileResponse(candidate)
        return _index_response()

    log.info("spa.mounted", dir=str(dist_dir), prefix=prefix, env=instance_env)
    return True

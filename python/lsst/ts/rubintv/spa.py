"""Serve the built SPA with a deep-link catch-all.

In production the React build (``web/dist``) is served by FastAPI: hashed
assets under ``/assets`` with long cache lifetimes, and a catch-all that
returns ``index.html`` for any non-API path so client-side deep links
survive a hard reload (the multi-tab guarantee, Decision 7).

Registered last, so it never shadows ``/api``, ``/ws``, or sub-app mounts.
If the build directory is absent (dev, where Vite serves the SPA), the
catch-all is not installed.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)


def mount_spa(app: FastAPI, dist_dir: Path | None, prefix: str = "") -> bool:
    """Serve the SPA from ``dist_dir``; returns True if mounted.

    The app is served beneath ``prefix`` (e.g. ``/rubintv``), so the catch-all
    and the hashed-asset mount live there too. Vite builds the SPA with a
    matching ``base``, so ``index.html`` requests assets at
    ``{prefix}/assets``.
    """
    if dist_dir is None or not (dist_dir / "index.html").is_file():
        log.info("spa.skip", reason="no build directory", dir=str(dist_dir))
        return False

    index = dist_dir / "index.html"
    assets = dist_dir / "assets"
    if assets.is_dir():
        app.mount(f"{prefix}/assets", StaticFiles(directory=assets), name="assets")

    # A visit to the bare prefix (e.g. /rubintv) must also serve the SPA; the
    # catch-all below only matches paths *under* the prefix.
    if prefix:

        @app.get(prefix, include_in_schema=False)
        def spa_root() -> FileResponse:
            return FileResponse(index)

    @app.get(f"{prefix}/{{full_path:path}}", include_in_schema=False)
    def spa_catch_all(full_path: str) -> FileResponse:
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
        return FileResponse(index)

    log.info("spa.mounted", dir=str(dist_dir), prefix=prefix)
    return True

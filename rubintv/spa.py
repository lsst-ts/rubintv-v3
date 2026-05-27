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

from rubintv.logging import get_logger

log = get_logger(__name__)


def mount_spa(app: FastAPI, dist_dir: Path | None) -> bool:
    """Serve the SPA from ``dist_dir``. Returns True if mounted."""
    if dist_dir is None or not (dist_dir / "index.html").is_file():
        log.info("spa.skip", reason="no build directory", dir=str(dist_dir))
        return False

    index = dist_dir / "index.html"
    assets = dist_dir / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_catch_all(full_path: str) -> FileResponse:
        # API/WS/sub-app routes are registered before this and take
        # precedence; anything reaching here that looks like an API call is
        # a genuine 404, not an SPA route.
        if full_path.startswith(("api/", "ws", "ddv", "exp_checker")):
            raise HTTPException(status_code=404)
        return FileResponse(index)

    log.info("spa.mounted", dir=str(dist_dir))
    return True

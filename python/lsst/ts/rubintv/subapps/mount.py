"""Mount optional sub-apps with failure isolation.

- **DDV** (Flutter): a static asset bundle served at ``/ddv``. If the build
  directory isn't present, the mount is skipped.
- **exp_checker**: a FastAPI sub-app mounted at ``/exp_checker``, sharing the
  main process. Loaded dynamically so its absence (or an import error) is
  non-fatal.

Each mount is wrapped so any failure is logged and skipped; the main app
always continues to serve.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from lsst.ts.rubintv.config.settings import Settings
from lsst.ts.rubintv.logging import get_logger
from starlette.staticfiles import StaticFiles

log = get_logger(__name__)


def mount_subapps(app: FastAPI, settings: Settings) -> list[str]:
    """Mount available sub-apps; return the list of mounted paths.

    Sub-apps mount under the app's ``path_prefix`` (e.g. ``/rubintv/ddv``),
    alongside the API and SPA. The returned paths are the full browser-facing
    URLs, so the frontend nav (``/api/subapps``) links them directly.
    """
    prefix = settings.path_prefix
    mounted: list[str] = []
    for name, mount_fn in (("ddv", _mount_ddv), ("exp_checker", _mount_exp_checker)):
        try:
            path = mount_fn(app, settings, prefix)
        except Exception as exc:  # noqa: BLE001 - isolation: never fatal
            log.warning("subapp.mount.failed", subapp=name, error=str(exc))
            continue
        if path is not None:
            mounted.append(path)
            _redirect_bare_path(app, path)
            log.info("subapp.mounted", subapp=name, path=path)
    return mounted


def _redirect_bare_path(app: FastAPI, path: str) -> None:
    """Send the slash-less mount path into the mount.

    Starlette mounts only match ``{path}/...``, so the bare path (which is
    what ``/api/subapps`` advertises and users type) would fall through to
    the SPA catch-all and 404. An explicit redirect closes that gap; the
    router's automatic slash-redirect can't, because the catch-all matches
    first.
    """

    async def bare() -> RedirectResponse:
        return RedirectResponse(f"{path}/")

    app.add_api_route(path, bare, include_in_schema=False)


def _mount_ddv(app: FastAPI, settings: Settings, prefix: str) -> str | None:
    """Serve the DDV Flutter build at {prefix}/ddv if its assets exist."""
    ddv_dir = settings.ddv_path
    if ddv_dir is None or not ddv_dir.is_dir():
        log.info("subapp.skip", subapp="ddv", reason="no build directory")
        return None
    path = f"{prefix}/ddv"
    app.mount(
        path,
        StaticFiles(directory=ddv_dir, html=True),
        name="ddv",
    )
    return path


def _mount_exp_checker(app: FastAPI, settings: Settings, prefix: str) -> str | None:
    """Mount the exp_checker sub-app at {prefix}/exp_checker if importable.

    The sub-app is expected to expose ``create_app() -> FastAPI`` (or an
    ``app`` instance). It is optional; absence is not an error.
    """
    if not settings.exp_checker_enabled:
        log.info("subapp.skip", subapp="exp_checker", reason="disabled")
        return None
    from importlib import import_module

    module = import_module(settings.exp_checker_module)
    sub: FastAPI = module.create_app() if hasattr(module, "create_app") else module.app
    path = f"{prefix}/exp_checker"
    app.mount(path, sub, name="exp_checker")
    return path

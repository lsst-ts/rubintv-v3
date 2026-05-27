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
from starlette.staticfiles import StaticFiles

from rubintv.config.settings import Settings
from rubintv.logging import get_logger

log = get_logger(__name__)


def mount_subapps(app: FastAPI, settings: Settings) -> list[str]:
    """Mount available sub-apps; return the list of mounted paths."""
    mounted: list[str] = []
    for name, mount_fn in (("ddv", _mount_ddv), ("exp_checker", _mount_exp_checker)):
        try:
            path = mount_fn(app, settings)
        except Exception as exc:  # noqa: BLE001 - isolation: never fatal
            log.warning("subapp.mount.failed", subapp=name, error=str(exc))
            continue
        if path is not None:
            mounted.append(path)
            log.info("subapp.mounted", subapp=name, path=path)
    return mounted


def _mount_ddv(app: FastAPI, settings: Settings) -> str | None:
    """Serve the DDV Flutter build at /ddv if its assets exist."""
    ddv_dir = settings.ddv_path
    if ddv_dir is None or not ddv_dir.is_dir():
        log.info("subapp.skip", subapp="ddv", reason="no build directory")
        return None
    app.mount(
        "/ddv",
        StaticFiles(directory=ddv_dir, html=True),
        name="ddv",
    )
    return "/ddv"


def _mount_exp_checker(app: FastAPI, settings: Settings) -> str | None:
    """Mount the exp_checker FastAPI sub-app at /exp_checker if importable.

    The sub-app is expected to expose ``create_app() -> FastAPI`` (or an
    ``app`` instance). It is optional; absence is not an error.
    """
    if not settings.exp_checker_enabled:
        log.info("subapp.skip", subapp="exp_checker", reason="disabled")
        return None
    from importlib import import_module

    module = import_module("exp_checker")
    sub: FastAPI = module.create_app() if hasattr(module, "create_app") else module.app
    app.mount("/exp_checker", sub, name="exp_checker")
    return "/exp_checker"

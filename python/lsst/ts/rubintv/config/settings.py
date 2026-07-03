"""Runtime settings (environment-driven), distinct from the domain models.

``Settings`` covers *how this process runs* — which site, where the config
file and cache live, Redis URL, poll cadence, log format. The *what exists*
(cameras, channels, locations) is the validated model tree loaded separately
by :mod:`rubintv.config.loader`.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Process-level configuration, populated from the environment.

    Environment variables are prefixed ``RUBINTV_`` (e.g.
    ``RUBINTV_SITE=summit``).
    """

    model_config = SettingsConfigDict(
        env_prefix="RUBINTV_",
        env_file=".env",
        extra="ignore",
    )

    site: str = "local"
    """Deployment site name; selects which locations are visible."""

    path_prefix: str = "/rubintv"
    """URL prefix the whole app is served under (``RUBINTV_PATH_PREFIX``).

    The deployment mounts everything — API, WebSockets, sub-apps, and the SPA
    — beneath this prefix, matching the previous app's ``/rubintv`` root, so
    external deep links resolve. Must start with ``/`` and carry no trailing
    slash (``/rubintv``, not ``rubintv/``); ``""`` serves at the root."""

    models_path: Path | None = None
    """Path to the YAML defining locations, cameras, channels, services.
    ``None`` (the default) uses the copy packaged inside
    ``lsst.ts.rubintv.models``; set ``RUBINTV_MODELS_PATH`` to override with an
    on-disk file (e.g. a site-specific mount)."""

    cache_dir: Path | None = Path("/scratch")
    """PVC cache directory for warm starts. Defaults to /scratch, the PVC
    mount used in deployments; when the directory is missing or unwritable
    (pods without a PVC, local dev) the cache disables itself with a single
    warning. ``None`` disables it explicitly."""

    redis_url: str | None = None
    """Redis connection URL. ``None`` disables detector/admin live updates."""

    spa_dist: Path | None = None
    """Directory of the built SPA (web/dist). ``None`` (dev) skips serving
    static assets; Vite serves the SPA in development."""

    ddv_path: Path | None = None
    """Directory of the built DDV Flutter app. ``None`` skips the /ddv
    mount."""

    exp_checker_enabled: bool = False
    """Mount the exp_checker sub-app at /exp_checker (must be importable)."""

    exp_checker_module: str = "lsst.ts.exp_checker"
    """Import path of the exp_checker package (must expose ``create_app()``
    or an ``app`` instance)."""

    poll_interval_seconds: float = 1.0
    """Current-day poll cadence."""

    recent_window_days: int = 30
    """On cold start, scan this many recent observing-days per camera before
    the full back-catalogue sweep, so recent history is viewable in seconds.
    ``0`` disables the recent-first phase (full sweep only)."""

    metadata_preload_days: int = 3
    """On cold start, pre-fetch metadata.json for this many of the most recent
    dates per camera into the in-memory LRU, so the first table view of a
    recent date is a warm hit instead of a cold S3 stream. Bounded by the
    cache's own LRU size and by the dates actually present. ``0`` disables
    preloading (metadata stays purely on-demand)."""

    witness_detector_key: str = "RUBINTV_CONTROL_WITNESS_DETECTOR"
    """Redis control key the admin 'Witness Detector' box writes to."""

    reset_head_node_key: str = "RUBINTV_CONTROL_RESET_HEAD_NODE"
    """Redis control key the admin 'Reset Head Node' button writes to (the
    value sent is the trigger sentinel ``reset_head_node_value``)."""

    reset_head_node_value: str = "1"
    """Value written to ``reset_head_node_key`` to trigger a head-node
    reset."""

    log_level: str = "INFO"
    json_logs: bool = False
    """Emit JSON logs (production). Off by default for local dev."""


@lru_cache
def get_settings() -> Settings:
    """Return the process settings (cached for the process lifetime)."""
    return Settings()

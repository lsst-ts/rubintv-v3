"""Build provenance: the git commit the running code was built from.

In the container these come from ``RUBINTV_GIT_SHA`` / ``RUBINTV_GIT_DATE``,
which the Dockerfile bakes in at image-build time from ``git`` build args —
the runtime image carries no ``.git`` directory, so the values can't be
recovered later. For local development the env vars are unset, so we fall
back to running ``git`` in the working tree. Everything is best-effort:
a missing env var, a missing git, or a non-repo checkout all resolve to
``"unknown"`` rather than raising, because build provenance is cosmetic and
must never keep the app from starting.
"""

from __future__ import annotations

import os
import subprocess
from functools import lru_cache

_UNKNOWN = "unknown"


def _git(*args: str) -> str | None:
    """Run ``git args...`` in the source tree, or return None on any failure."""
    try:
        out = subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            timeout=2,
            cwd=os.path.dirname(__file__),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    value = out.stdout.strip()
    return value or None


@lru_cache(maxsize=1)
def git_sha() -> str:
    """Short git hash of the built commit ("unknown" if unavailable)."""
    return (
        os.environ.get("RUBINTV_GIT_SHA")
        or _git("rev-parse", "--short", "HEAD")
        or _UNKNOWN
    )


@lru_cache(maxsize=1)
def commit_date() -> str:
    """Commit date of the built commit as YYYY-MM-DD ("unknown" if unavailable)."""
    return (
        os.environ.get("RUBINTV_GIT_DATE")
        or _git("log", "-1", "--format=%cd", "--date=format:%Y-%m-%d")
        or _UNKNOWN
    )

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
    """Run ``git args...`` in the source tree, or return None on any
    failure."""
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
    """Commit date of the built commit as YYYY-MM-DD ("unknown" if
    unavailable)."""
    return (
        os.environ.get("RUBINTV_GIT_DATE")
        or _git("log", "-1", "--format=%cd", "--date=format:%Y-%m-%d")
        or _UNKNOWN
    )


@lru_cache(maxsize=1)
def is_release() -> bool:
    """Whether this is a built/deployed image rather than a live checkout.

    The Dockerfile bakes ``RUBINTV_GIT_SHA`` in at image-build time, so a
    *real* value marks a deployed build. Local development leaves it unset (the
    sha/date come from live ``git`` instead). The Admin header uses this to
    show the full setuptools-scm version only where it's meaningful — a
    release image — and to drop the noisy ``dev+g<sha>`` string locally.

    A build-arg-less ``docker build`` leaves ``RUBINTV_GIT_SHA`` at its
    ``"unknown"`` default; that is *not* a release (it would otherwise show a
    "release" with sha "unknown" in Admin), so the sentinel is excluded.
    """
    sha = os.environ.get("RUBINTV_GIT_SHA")
    return bool(sha) and sha != _UNKNOWN

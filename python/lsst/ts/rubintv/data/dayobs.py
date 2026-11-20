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

"""The observing-day (day_obs) boundary.

The observatory rolls the date at noon UTC (the "observing day" runs noon
UTC to noon UTC), implemented as a UTC-12 offset.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta


def get_current_day_obs(now: datetime | None = None) -> str:
    """Return the current observing day as an ISO ``YYYY-MM-DD`` string."""
    now = now or datetime.now(UTC)
    return (now - timedelta(hours=12)).strftime("%Y-%m-%d")


def recent_day_obs(days: int, now: datetime | None = None) -> list[str]:
    """Return the last ``days`` observing-days, newest first.

    ``recent_day_obs(1)`` is just today's day_obs; ``days <= 0`` yields an
    empty list. Used to scan the recent window before the full sweep.
    """
    now = now or datetime.now(UTC)
    start = now - timedelta(hours=12)
    return [(start - timedelta(days=d)).strftime("%Y-%m-%d") for d in range(days)]

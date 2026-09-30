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

"""day_obs (UTC-12) boundary."""

from __future__ import annotations

from datetime import UTC, datetime

from lsst.ts.rubintv.data.dayobs import get_current_day_obs, recent_day_obs


def test_before_noon_utc_is_previous_day() -> None:
    # 06:00 UTC on the 10th -> still the 9th observing day (minus 12h).
    now = datetime(2026, 4, 10, 6, 0, tzinfo=UTC)
    assert get_current_day_obs(now) == "2026-04-09"


def test_after_noon_utc_is_same_day() -> None:
    now = datetime(2026, 4, 10, 18, 0, tzinfo=UTC)
    assert get_current_day_obs(now) == "2026-04-10"


def test_exactly_noon_utc_rolls_over() -> None:
    now = datetime(2026, 4, 10, 12, 0, tzinfo=UTC)
    assert get_current_day_obs(now) == "2026-04-10"


def test_recent_day_obs_newest_first() -> None:
    now = datetime(2026, 4, 10, 18, 0, tzinfo=UTC)  # day_obs == 2026-04-10
    assert recent_day_obs(3, now) == ["2026-04-10", "2026-04-09", "2026-04-08"]


def test_recent_day_obs_one_day_is_today() -> None:
    now = datetime(2026, 4, 10, 18, 0, tzinfo=UTC)
    assert recent_day_obs(1, now) == ["2026-04-10"]


def test_recent_day_obs_zero_is_empty() -> None:
    assert recent_day_obs(0) == []


def test_recent_day_obs_respects_noon_boundary() -> None:
    # 06:00 UTC -> day_obs is the previous day, so the window starts there.
    now = datetime(2026, 4, 10, 6, 0, tzinfo=UTC)
    assert recent_day_obs(2, now) == ["2026-04-09", "2026-04-08"]

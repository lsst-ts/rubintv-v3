"""day_obs (UTC-12) boundary."""

from __future__ import annotations

from datetime import UTC, datetime

from rubintv.data.dayobs import get_current_day_obs


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

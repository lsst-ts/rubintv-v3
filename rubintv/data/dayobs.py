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

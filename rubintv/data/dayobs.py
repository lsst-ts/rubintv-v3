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

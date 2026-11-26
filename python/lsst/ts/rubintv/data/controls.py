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

"""Admin control values (readback).

A minimal in-memory store of control key -> value, per location. Phase 4
replaces this with a Redis-backed implementation that also receives live
``_READBACK`` updates; the interface stays the same so the API and admin
gating don't change.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass


class ControlStore:
    """In-memory control values keyed by (location, key)."""

    def __init__(self) -> None:
        self._values: dict[str, dict[str, str]] = defaultdict(dict)

    def all(self, location: str) -> dict[str, str]:
        return dict(self._values.get(location, {}))

    def set(self, location: str, key: str, value: str) -> None:
        self._values[location][key] = value

    def discard(self, location: str, key: str) -> None:
        """Forget a value (its key is gone from Redis)."""
        self._values.get(location, {}).pop(key, None)


@dataclass
class RedisLink:
    """Whether Redis is being read, and when it last answered.

    The Cluster Status and Admin pages show what Redis last said, so without
    this a picture from before an outage reads as current. Written by the
    Redis readers; sent with every detector and readback message and
    reported by the status endpoints.
    """

    configured: bool = False
    """A Redis URL is set, so the readers are running (or trying to)."""
    connected: bool = False
    """Every reader's last exchange with Redis succeeded."""
    changed_at: float | None = None
    """When ``connected`` last flipped (``time.monotonic``); for a Redis that
    has never answered, when the readers started."""
    read_at: float | None = None
    """When Redis last answered a reader (``time.monotonic``)."""

    def report(self) -> dict[str, object]:
        """The state as ages, so a page can place them on its own clock
        whatever the server's says (as ``last_poll_age_seconds`` does)."""
        now = time.monotonic()
        return {
            "configured": self.configured,
            "connected": self.connected,
            "changed_age_seconds": _age(now, self.changed_at),
            "read_age_seconds": _age(now, self.read_at),
        }


def _age(now: float, then: float | None) -> float | None:
    return None if then is None else round(max(0.0, now - then), 3)


class DetectorStore:
    """Latest cluster-status payload per detector set.

    Detector status is site-wide (the Redis ``redis_detectors`` streams are
    not scoped to a location), so this is a ``set_name -> payload`` map keyed
    by the config ``name`` (e.g. ``sfmSet0``, ``otherQueues``). Each payload
    mirrors what the Cluster Status page renders per set::

        {"workers": {"0": {"status": "busy"}, ...},  # worker_status entries
         "numWorkers": 8,                              # worker_count entry
         "text": {"queueA": "3", ...}}                 # text_status entries

    Populated by the Redis stream reader; read by the WS handler when answering
    a ``detectors`` subscription snapshot.

    The producer writes a set only when it changes, so each payload is kept
    with the time it was written (from its stream entry id): a set that has
    not changed for hours, and one whose producer has died, are otherwise
    the same picture as one written a second ago.
    """

    def __init__(self) -> None:
        self._status: dict[str, dict[str, object]] = {}
        self._written_at: dict[str, float] = {}

    def all(self) -> dict[str, dict[str, object]]:
        """A (shallow-per-set) copy of every set's latest payload."""
        return {name: dict(payload) for name, payload in self._status.items()}

    def set(
        self,
        name: str,
        payload: dict[str, object],
        written_at: float | None = None,
    ) -> None:
        """Replace the latest payload for one detector set. ``written_at``
        is when the producer wrote it (epoch seconds), if known."""
        self._status[name] = dict(payload)
        if written_at is None:
            self._written_at.pop(name, None)
        else:
            self._written_at[name] = written_at

    def ages(self) -> dict[str, float]:
        """Seconds since each set's payload was written, for those whose
        time is known."""
        now = time.time()
        return {
            name: round(max(0.0, now - written), 3)
            for name, written in self._written_at.items()
        }

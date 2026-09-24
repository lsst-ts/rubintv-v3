"""Liveness tracking for Rapid Analysis services.

RA service processes run alongside this app in the same k8s pod and report
that they're alive by beating periodically (over the internal WS or POST
endpoint — see ``rubintv.ws.internal``). Each beat carries a ``ttl``: how
many seconds the service should be considered live without a further beat.

Liveness is computed at read time (``now - last_seen < ttl``) so no reaper is
needed for correctness; a service that stops beating simply reads as stale.
The internal service runs a light reaper only to *publish* the live→stale
transition so the UI updates without a client poll.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass

# Cap on distinct tracked services. The heartbeat endpoint records an arbitrary
# service name per beat; without a bound, anything able to reach it (the
# endpoint relies on the ingress keeping /internal private) could inject
# unlimited names and grow the store without limit. At the cap the
# least-recently-seen service is evicted.
_MAX_SERVICES = 1024


@dataclass(slots=True)
class _Beat:
    last_seen: float  # monotonic seconds
    ttl: float
    location: str | None


class HeartbeatStore:
    """Latest beat per service, with read-time liveness.

    Keyed by service name (e.g. ``auxtel_metadata``). Mirrors the shape of
    ``DetectorStore``: the internal endpoint writes, the WS handler and the
    status API read.
    """

    def __init__(self) -> None:
        # OrderedDict so we can evict the least-recently-seen service when the
        # distinct-service cap is hit.
        self._beats: OrderedDict[str, _Beat] = OrderedDict()

    def beat(self, service: str, ttl: float, location: str | None = None) -> bool:
        """Record a beat. Returns True if this revived a previously-stale
        service."""
        was_live = self._is_live(self._beats.get(service))
        self._beats[service] = _Beat(time.monotonic(), ttl, location)
        self._beats.move_to_end(service)
        while len(self._beats) > _MAX_SERVICES:
            self._beats.popitem(last=False)
        return not was_live

    def all(self) -> dict[str, dict[str, object]]:
        """Every known service with its current liveness, for
        snapshot/probe."""
        now = time.monotonic()
        return {
            name: {
                "live": self._is_live(beat, now),
                "ttl": beat.ttl,
                "age": round(now - beat.last_seen, 3),
                "location": beat.location,
            }
            for name, beat in self._beats.items()
        }

    def newly_stale(self) -> list[str]:
        """Service names that have just crossed from live to stale.

        Drives the reaper's transition publish: a service appears here once,
        when it first reads stale, and not again until it beats and lapses
        anew. (Implemented by dropping the lapsed beat once reported.)
        """
        now = time.monotonic()
        stale = [n for n, b in self._beats.items() if not self._is_live(b, now)]
        for name in stale:
            del self._beats[name]
        return stale

    @staticmethod
    def _is_live(beat: _Beat | None, now: float | None = None) -> bool:
        if beat is None:
            return False
        return (now or time.monotonic()) - beat.last_seen < beat.ttl

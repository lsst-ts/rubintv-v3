"""Admin control values (readback).

A minimal in-memory store of control key -> value, per location. Phase 4
replaces this with a Redis-backed implementation that also receives live
``_READBACK`` updates; the interface stays the same so the API and admin
gating don't change.
"""

from __future__ import annotations

from collections import defaultdict


class ControlStore:
    """In-memory control values keyed by (location, key)."""

    def __init__(self) -> None:
        self._values: dict[str, dict[str, str]] = defaultdict(dict)

    def all(self, location: str) -> dict[str, str]:
        return dict(self._values.get(location, {}))

    def set(self, location: str, key: str, value: str) -> None:
        self._values[location][key] = value


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
    """

    def __init__(self) -> None:
        self._status: dict[str, dict[str, object]] = {}

    def all(self) -> dict[str, dict[str, object]]:
        """A (shallow-per-set) copy of every set's latest payload."""
        return {name: dict(payload) for name, payload in self._status.items()}

    def set(self, name: str, payload: dict[str, object]) -> None:
        """Replace the latest payload for one detector set."""
        self._status[name] = dict(payload)

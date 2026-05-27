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

"""Typed WebSocket protocol — client requests and server messages.

Both directions are Pydantic models so the schema is shared with the
frontend the same way REST types are (no stringly-typed messages).

A *topic* is what a client subscribes to. It is identified by a
``(kind, location, camera, channel?)`` tuple and rendered to a stable string
key for the subscription registry.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

TopicKind = Literal["camera", "channel", "nightReport", "detectors", "admin"]


class SubscribeRequest(BaseModel):
    action: Literal["subscribe", "unsubscribe"]
    topic: TopicKind
    location: str
    camera: str | None = None
    channel: str | None = None

    def topic_key(self) -> str:
        """Stable string key identifying this topic for the registry."""
        return "|".join(
            [self.topic, self.location, self.camera or "", self.channel or ""]
        )


# --- server -> client messages ---

ServerMessageType = Literal[
    "channelData",
    "event",
    "metadata",
    "perDay",
    "nightReport",
    "dayChange",
    "detectorStatus",
    "controlReadback",
    "calendarUpdate",
    "error",
    "subscribed",
]


class ServerMessage(BaseModel):
    type: ServerMessageType
    location: str | None = None
    camera: str | None = None
    channel: str | None = None
    date: str | None = None
    data: dict[str, object] | None = None
    message: str | None = None

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

TopicKind = Literal[
    "camera", "channel", "nightReport", "detectors", "admin", "services"
]


class SubscribeRequest(BaseModel):
    action: Literal["subscribe", "unsubscribe"]
    topic: TopicKind
    location: str
    camera: str | None = None
    channel: str | None = None
    date: str | None = None
    """Optional date for a camera subscription. When present, the server
    streams that date's metadata to this client as ``metadataChunk`` frames.
    It is *not* part of the topic key — the live-change subscription is per
    camera, while metadata streaming is a one-shot per (camera, date)."""

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
    "metadataChunk",
    "metadataComplete",
    "perDay",
    "nightReport",
    "dayChange",
    "detectorStatus",
    "controlReadback",
    "serviceStatus",
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
    # Metadata streaming: a metadataChunk carries one slice of the date's
    # metadata dict with its position (seq of total) for client progress; the
    # final metadataComplete carries the S3 etag so the client can skip a
    # re-stream on resubscribe of an unchanged date.
    seq: int | None = None
    total: int | None = None
    etag: str | None = None

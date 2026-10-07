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

"""Typed WebSocket protocol — client requests and server messages.

Both directions are Pydantic models so the schema is shared with the
frontend the same way REST types are (no stringly-typed messages).

A *topic* is what a client subscribes to. It is identified by a
``(kind, location, camera?)`` tuple and rendered to a stable string key for
the subscription registry.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

TopicKind = Literal["camera", "nightReport", "detectors", "admin"]


class SubscribeRequest(BaseModel):
    action: Literal["subscribe", "unsubscribe"]
    topic: TopicKind
    location: str
    camera: str | None = None
    date: str | None = None
    """Optional date for a camera subscription. When present, the server
    streams that date's metadata to this client as ``metadataChunk`` frames.
    It is *not* part of the topic key — the live-change subscription is per
    camera, while metadata streaming is a one-shot per (camera, date)."""

    def topic_key(self) -> str:
        """Stable string key identifying this topic for the registry."""
        return "|".join([self.topic, self.location, self.camera or ""])


# --- server -> client messages ---

ServerMessageType = Literal[
    "channelData",
    "metadata",
    "metadataChunk",
    "metadataComplete",
    "perDay",
    "nightReport",
    "dayChange",
    "detectorStatus",
    "controlReadback",
    "calendarUpdate",
    "error",
]


class ServerMessage(BaseModel):
    type: ServerMessageType
    location: str | None = None
    camera: str | None = None
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

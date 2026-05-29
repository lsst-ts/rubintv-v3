"""S3 client pool: pooled boto3 clients per location.

Locations differ in bucket, profile, and endpoint (summit direct S3 vs.
USDF, etc.), so each gets its own client. Two separate clients are kept
per location:

- the **default** client serves on-demand request traffic (metadata
  fetches, the object proxy, night-report fetches),
- the **poller** client is used by the background ``S3Poller`` only.

The split exists because the poller issues a sustained burst of
``list_objects_v2`` calls each cycle that can fill a shared HTTP
connection pool, leaving an interactive ``head_object`` for a
``metadata.json`` queued behind tens of seconds of listings (observed:
30+ second metadata fetches under a serial 30-camera scan loop).

Clients are created lazily and reused; ``close`` releases them on
shutdown. Use ``warm_up`` at startup to create both sets concurrently —
each ``boto3.session.Session`` is ~0.5–1s of cold init.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import boto3
from botocore.config import Config

from rubintv.config.models import Location
from rubintv.logging import get_logger

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client

log = get_logger(__name__)


class S3ClientPool:
    """Holds default and poller S3 clients per location."""

    def __init__(self, locations: list[Location]) -> None:
        self._locations = {loc.name: loc for loc in locations}
        self._clients: dict[str, S3Client] = {}
        self._poller_clients: dict[str, S3Client] = {}

    def client_for(self, location_name: str) -> S3Client:
        """Return (creating if needed) the on-demand client for a location."""
        if location_name in self._clients:
            return self._clients[location_name]
        client = self._build(location_name, role="default")
        self._clients[location_name] = client
        return client

    def poller_client_for(self, location_name: str) -> S3Client:
        """Return (creating if needed) the poller-only client for a location.

        Kept separate from ``client_for`` so the background poller's
        sustained ``list_objects_v2`` traffic doesn't saturate the HTTP
        connection pool the interactive handlers share.
        """
        if location_name in self._poller_clients:
            return self._poller_clients[location_name]
        client = self._build(location_name, role="poller")
        self._poller_clients[location_name] = client
        return client

    def _build(self, location_name: str, *, role: str) -> S3Client:
        location = self._locations.get(location_name)
        if location is None:
            raise KeyError(f"unknown location: {location_name}")
        session = boto3.session.Session(profile_name=location.profile)
        client = session.client(
            "s3",
            endpoint_url=location.endpoint,
            config=Config(
                retries={"max_attempts": 3, "mode": "standard"},
                max_pool_connections=32,
            ),
        )
        log.info("s3.client.created", location=location_name, role=role)
        return client

    async def warm_up(self) -> None:
        """Pre-create every pooled client (default + poller) concurrently.

        Each boto3 session init is blocking (~0.5–1s cold), so doing them
        serially on the event loop would otherwise stretch startup and
        the first poll cycle. We run them in worker threads in parallel.
        """
        jobs: list[tuple[str, str, dict[str, S3Client]]] = []
        for name in self._locations:
            if name not in self._clients:
                jobs.append((name, "default", self._clients))
            if name not in self._poller_clients:
                jobs.append((name, "poller", self._poller_clients))
        if not jobs:
            return

        async def _make(
            name: str, role: str
        ) -> tuple[str, str, S3Client]:
            client = await asyncio.to_thread(self._build, name, role=role)
            return name, role, client

        results = await asyncio.gather(*(_make(n, r) for n, r, _ in jobs))
        targets = {"default": self._clients, "poller": self._poller_clients}
        for name, role, client in results:
            targets[role].setdefault(name, client)

    def close(self) -> None:
        """Close all pooled clients."""
        for name, client in self._clients.items():
            client.close()
            log.info("s3.client.closed", location=name, role="default")
        for name, client in self._poller_clients.items():
            client.close()
            log.info("s3.client.closed", location=name, role="poller")
        self._clients.clear()
        self._poller_clients.clear()

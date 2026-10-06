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
from lsst.ts.rubintv.config.models import Location
from lsst.ts.rubintv.logging import get_logger

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client

log = get_logger(__name__)


class S3ClientPool:
    """Holds default and poller S3 clients per location."""

    def __init__(
        self, locations: list[Location], *, default_endpoint: str | None = None
    ) -> None:
        self._locations = {loc.name: loc for loc in locations}
        # Used for a location that declares no endpoint of its own (the
        # deployment's ``S3_ENDPOINT_URL``). Empty counts as unset.
        self._default_endpoint = default_endpoint or None
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
        endpoint = location.endpoint or self._default_endpoint
        # The poller runs on a ~1s cadence, so a hung connection must fail fast
        # rather than block on botocore's 60s default connect timeout (×3
        # retries = a minute-plus before a dead endpoint/tunnel surfaces as an
        # error). Cap it tight: a 5s connect timeout with one retry (botocore
        # ``max_attempts`` is the retry count -> 2 total attempts) means a dead
        # endpoint raises in ~10s, not 60s+. The default (interactive) client
        # keeps the standard, more patient retry policy for user requests.
        if role == "poller":
            config = Config(
                connect_timeout=5,
                read_timeout=10,
                retries={"max_attempts": 1, "mode": "standard"},
                max_pool_connections=32,
            )
        else:
            config = Config(
                retries={"max_attempts": 3, "mode": "standard"},
                max_pool_connections=32,
            )
        client = session.client(
            "s3",
            endpoint_url=endpoint,
            config=config,
        )
        log.info(
            "s3.client.created",
            location=location_name,
            role=role,
            endpoint=endpoint or "default",
        )
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

        async def _make(name: str, role: str) -> tuple[str, str, S3Client]:
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

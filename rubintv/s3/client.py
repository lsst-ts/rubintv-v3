"""S3 client pool: one pooled boto3 client per location.

Locations differ in bucket, profile, and endpoint (summit direct S3 vs.
USDF, etc.), so each gets its own client. Clients are created lazily and
reused; ``close`` releases them on shutdown.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import boto3
from botocore.config import Config

from rubintv.config.models import Location
from rubintv.logging import get_logger

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client

log = get_logger(__name__)


class S3ClientPool:
    """Holds one boto3 S3 client per location, created on demand."""

    def __init__(self, locations: list[Location]) -> None:
        self._locations = {loc.name: loc for loc in locations}
        self._clients: dict[str, S3Client] = {}

    def client_for(self, location_name: str) -> S3Client:
        """Return (creating if needed) the S3 client for a location."""
        if location_name in self._clients:
            return self._clients[location_name]

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
        self._clients[location_name] = client
        log.info("s3.client.created", location=location_name)
        return client

    def close(self) -> None:
        """Close all pooled clients."""
        for name, client in self._clients.items():
            client.close()
            log.info("s3.client.closed", location=name)
        self._clients.clear()

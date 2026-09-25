"""A minimal ConsDB client: one SQL string in, columns and rows out.

ConsDB's ``pqserver`` exposes ``POST <root>/consdb/query`` taking
``{"query": "<sql>"}`` and answering ``{"columns": [...], "data": [[...]]}``
(capped at a million rows server-side). In the cluster the service is
reached directly (``http://consdb-pq.consdb:8080``) with no auth; from a
laptop it sits behind Gafaelfawr on an RSP host and wants a bearer token.
This mirrors how the Rapid Analysis log explorer reaches the same
endpoint from its Phalanx deployment.

Only the standard library is used: the query runs in a worker thread so
the event loop is never blocked by a slow database.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)


class ConsDbError(RuntimeError):
    """The query could not be run or its reply could not be read."""


@dataclass(frozen=True)
class QueryResult:
    columns: list[str]
    rows: list[list[Any]]

    def records(self) -> list[dict[str, Any]]:
        """Rows as dicts keyed by column name."""
        return [dict(zip(self.columns, row, strict=True)) for row in self.rows]


def read_token(path: Path | None) -> str | None:
    """Read a bearer token from ``path``; ``None`` when unset, missing or
    empty.

    A missing or unreadable file is logged, not raised: the token gates an
    optional feature (a Zephyr refresh, an out-of-cluster ConsDB), and a
    site whose secret hasn't been populated yet should come up without it
    rather than crash-loop. An empty file is "no token" for the same
    reason, and so a mounted-but-blank secret never sends a bare
    ``Bearer`` header the server would reject outright.
    """
    if path is None:
        return None
    try:
        token = Path(path).expanduser().read_text().strip()
    except OSError as exc:
        log.warning("token.unreadable", path=str(path), error=str(exc))
        return None
    return token or None


class ConsDbClient:
    """POST SQL to a ConsDB query endpoint."""

    def __init__(self, url: str, token: str | None = None, timeout: float = 120.0):
        self.url = url
        self._token = token
        self._timeout = timeout

    def query_sync(self, sql: str) -> QueryResult:
        """Run ``sql`` and return its result (blocking)."""
        body = json.dumps({"query": sql}).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        req = Request(self.url, data=body, headers=headers, method="POST")
        try:
            with urlopen(req, timeout=self._timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:500]
            except Exception:  # noqa: BLE001 - the status is the message
                pass
            raise ConsDbError(f"ConsDB HTTP {exc.code}: {exc.reason} {detail}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise ConsDbError(f"ConsDB unreachable: {exc}") from exc
        except ValueError as exc:
            raise ConsDbError(f"ConsDB returned non-JSON: {exc}") from exc
        columns = payload.get("columns")
        rows = payload.get("data")
        if not isinstance(columns, list) or not isinstance(rows, list):
            raise ConsDbError("ConsDB reply lacks 'columns'/'data'")
        return QueryResult(columns=[str(c) for c in columns], rows=rows)

    async def query(self, sql: str) -> QueryResult:
        """Run ``sql`` off the event loop."""
        return await asyncio.to_thread(self.query_sync, sql)

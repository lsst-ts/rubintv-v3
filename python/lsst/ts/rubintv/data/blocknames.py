"""Human-readable names for the observing blocks' science programs.

Science programs are recorded as ``BLOCK-T123`` (occasionally ``BLOCK-123``
or with a version suffix). The ``BLOCK-T`` keys are test cases in the
Zephyr Scale project ``BLOCK`` on the observatory's Jira, so their names
come from Zephyr's own REST API, not Jira's issue API. A snapshot of that
mapping ships with the package (the same file the original RubinTV Guide
committed by hand) so the guide is useful with no credentials at all; with
a Zephyr token configured the service refreshes it periodically.

The plain ``BLOCK-123`` form is a historical naming slip: those programs
almost always mean ``BLOCK-T123``, and the frontend does that rewrite on
lookup exactly as the original guide did.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from importlib.resources import files
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)

SNAPSHOT_RESOURCE = "tblock_names.json"


def load_snapshot() -> dict[str, str]:
    """The block names bundled with the package."""
    resource = files("lsst.ts.rubintv.models").joinpath(SNAPSHOT_RESOURCE)
    raw = json.loads(resource.read_text())
    return {str(k): str(v) for k, v in raw.items()}


class ZephyrError(RuntimeError):
    """A Zephyr Scale request failed."""


def fetch_zephyr_names(
    base_url: str,
    token: str,
    project_key: str,
    *,
    page_size: int = 1000,
    timeout: float = 60.0,
) -> dict[str, str]:
    """Return ``{test case key: name}`` for every test case in the project.

    Pages through ``GET /testcases`` following the ``next`` link Zephyr
    returns until there is none. Blocking; callers run it in a thread.
    """
    names: dict[str, str] = {}
    params = {"projectKey": project_key, "maxResults": page_size, "startAt": 0}
    url: str | None = f"{base_url.rstrip('/')}/testcases?{urlencode(params)}"
    headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
    while url:
        req = Request(url, headers=headers)
        try:
            with urlopen(req, timeout=timeout) as resp:
                page: dict[str, Any] = json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            raise ZephyrError(f"Zephyr HTTP {exc.code}: {exc.reason}") from exc
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            raise ZephyrError(f"Zephyr unreachable: {exc}") from exc
        for case in page.get("values") or []:
            key, name = case.get("key"), case.get("name")
            if key and name:
                names[str(key)] = str(name)
        nxt = page.get("next")
        url = str(nxt) if nxt else None
    return names


class BlockNameService:
    """Serve the block names, refreshing from Zephyr when configured."""

    def __init__(
        self,
        snapshot: dict[str, str],
        *,
        zephyr_url: str | None = None,
        zephyr_token: str | None = None,
        project_key: str = "BLOCK",
        refresh_interval: float = 86400.0,
    ) -> None:
        self._names = dict(snapshot)
        self.source = "snapshot"
        self.updated_at: datetime | None = None
        self.error: str | None = None
        self._zephyr_url = zephyr_url
        self._token = zephyr_token
        self._project = project_key
        self._interval = refresh_interval
        self._task: asyncio.Task[None] | None = None

    @property
    def names(self) -> dict[str, str]:
        return self._names

    @property
    def refresh_enabled(self) -> bool:
        return bool(self._zephyr_url and self._token)

    def start(self) -> None:
        if self.refresh_enabled:
            self._task = asyncio.create_task(self._loop(), name="block-names")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def refresh(self) -> bool:
        """Fetch from Zephyr; ``True`` if the names were replaced.

        A fetch that comes back empty is treated as a failure: replacing a
        useful snapshot with nothing would blank every description over a
        transient API problem.
        """
        if not self.refresh_enabled:
            return False
        assert self._zephyr_url is not None and self._token is not None
        try:
            fetched = await asyncio.to_thread(
                fetch_zephyr_names, self._zephyr_url, self._token, self._project
            )
        except ZephyrError as exc:
            self.error = str(exc)
            log.warning("blocknames.refresh.failed", error=str(exc))
            return False
        if not fetched:
            self.error = "Zephyr returned no test cases"
            log.warning("blocknames.refresh.empty", project=self._project)
            return False
        # Keep snapshot-only keys: a test case deleted upstream may still
        # name blocks already observed.
        merged = dict(self._names)
        merged.update(fetched)
        self._names = merged
        self.source = "zephyr"
        self.updated_at = datetime.now(UTC)
        self.error = None
        log.info("blocknames.refreshed", count=len(fetched))
        return True

    async def _loop(self) -> None:
        while True:
            try:
                await self.refresh()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one failed refresh must not kill it
                log.exception("blocknames.refresh.error")
            await asyncio.sleep(self._interval)

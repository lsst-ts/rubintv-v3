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

"""Human-readable names for the observing blocks' science programs.

Science programs are recorded as ``BLOCK-T123`` or ``BLOCK-123``, sometimes
with a version suffix. Both live in the observatory Jira's ``BLOCK``
project but are different things: ``BLOCK-T123`` is a Zephyr Scale test
case, named through Zephyr's own REST API, and ``BLOCK-123`` is a Jira
issue (``BLOCK-365``, for one, is the generic survey-imaging block the
scheduler's surveys record under), named by its summary through Jira's
issue search. The similar numbers mean nothing: ``BLOCK-123`` is not
``BLOCK-T123``, and isn't given its name.

A snapshot of the test-case names ships with the package (the same file
the original RubinTV Guide committed by hand) so the guide is useful with
no credentials at all; with a Zephyr token, a Jira API token, or both
configured, the service refreshes from them periodically.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
from collections.abc import Callable
from datetime import UTC, datetime
from functools import partial
from importlib.resources import files
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)

SNAPSHOT_RESOURCE = "tblock_names.json"

# TEMPORARY: names for the plain BLOCK-123 programs observed so far, served
# until a Jira token is deployed. A Jira refresh replaces them with the
# issues' own summaries (the ones here are those, bar the first two);
# delete this once RUBINTV_JIRA_TOKEN_FILE is set in every deployment.
INTERIM_ISSUE_NAMES = {
    "BLOCK-365": "Generic survey imaging (science validation)",
    "BLOCK-407": "Generic survey imaging (LSST survey)",
    "BLOCK-351": "LSSTCam on TMA: Create test case for Bright Star Illumination",
    "BLOCK-368": "LSSTCam on TMA: Create test case for Filter Swap",
    "BLOCK-378": (
        "Create a JSON file for the stray light from M2 baffle test with CBP"
        " - BLOCK-T445"
    ),
    "BLOCK-387": "Pointing model observations with LSSTCam",
    "BLOCK-390": "Verify pointing model",
    "BLOCK-408": (
        "v1 configuration early ops LSST survey for known poor seeing conditions"
    ),
    "BLOCK-416": "v2 config for constrained early ops LSST survey",
    "BLOCK-417": "v3 configuration constrained early ops LSST survey",
    "BLOCK-419": "v4 configuration for constrained early ops LSST survey",
    "BLOCK-421": (
        "v5 configuration standard pre-LSST survey with first alerts extra visits"
    ),
}


def load_snapshot() -> dict[str, str]:
    """The test-case names bundled with the package."""
    resource = files("lsst.ts.rubintv.models").joinpath(SNAPSHOT_RESOURCE)
    raw = json.loads(resource.read_text())
    return {str(k): str(v) for k, v in raw.items()}


class BlockNamesError(RuntimeError):
    """Fetching names from one of the sources failed."""


class ZephyrError(BlockNamesError):
    """A Zephyr Scale request failed."""


class JiraError(BlockNamesError):
    """A Jira request failed."""


def token_identity(token: str) -> dict[str, str]:
    """What a log line may say about ``token`` without revealing it.

    Always a short SHA-256 fingerprint, so a replaced secret can be told
    from the old one: compare it with ``printf %s "$TOKEN" | sha256sum``.
    Zephyr Scale tokens are JWTs naming the Jira site and account they act
    as; those claims are added when the token decodes as one.
    """
    ident = {"token_sha256": hashlib.sha256(token.encode()).hexdigest()[:12]}
    try:
        segment = token.split(".")[1]
        padded = segment + "=" * (-len(segment) % 4)
        claims = json.loads(base64.urlsafe_b64decode(padded))
    except (IndexError, ValueError):
        return ident
    if not isinstance(claims, dict):
        return ident
    context = claims.get("context")
    if isinstance(context, dict):
        if context.get("baseUrl"):
            ident["jira"] = str(context["baseUrl"])
        user = context.get("user")
        if isinstance(user, dict) and user.get("accountId"):
            ident["account_id"] = str(user["accountId"])
    try:
        expires = datetime.fromtimestamp(int(claims["exp"]), UTC)
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        return ident
    ident["token_expires"] = expires.isoformat()
    return ident


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
    returns until there is none. That list leaves some test cases out
    (archived ones, it seems; BLOCK-T456 and BLOCK-T510 among them, both
    observed under), so each key missing from the run up to the highest
    listed one is then asked for on its own. Blocking; callers run it in a
    thread.
    """
    root = base_url.rstrip("/")
    headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}

    def get(url: str, *, missing_ok: bool = False) -> dict[str, Any] | None:
        req = Request(url, headers=headers)
        try:
            with urlopen(req, timeout=timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            if missing_ok and exc.code == 404:
                return None
            raise ZephyrError(f"Zephyr HTTP {exc.code}: {exc.reason}") from exc
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            raise ZephyrError(f"Zephyr unreachable: {exc}") from exc
        if not isinstance(body, dict):
            raise ZephyrError("Zephyr returned an unexpected page")
        return body

    names: dict[str, str] = {}
    params = {"projectKey": project_key, "maxResults": page_size, "startAt": 0}
    url: str | None = f"{root}/testcases?{urlencode(params)}"
    while url:
        page = get(url)
        assert page is not None
        for case in page.get("values") or []:
            key, name = case.get("key"), case.get("name")
            if key and name:
                names[str(key)] = str(name)
        nxt = page.get("next")
        url = str(nxt) if nxt else None

    pattern = re.compile(rf"{re.escape(project_key)}-T(\d+)")
    listed = {int(m[1]) for key in names if (m := pattern.fullmatch(key))}
    for number in sorted(set(range(1, max(listed, default=0))) - listed):
        key = f"{project_key}-T{number}"
        case = get(f"{root}/testcases/{key}", missing_ok=True)
        if case and case.get("name"):
            names[key] = str(case["name"])
    return names


def basic_account(credential: str) -> str | None:
    """The account a basic-auth ``credential`` (base64 of ``email:token``)
    names, or ``None`` if it isn't one. The token half is never returned.
    """
    try:
        decoded = base64.b64decode(credential, validate=True).decode()
    except ValueError:
        return None
    account, sep, _ = decoded.partition(":")
    return account if sep and account else None


def fetch_jira_names(
    base_url: str,
    credential: str,
    project_key: str,
    *,
    page_size: int = 100,
    timeout: float = 60.0,
) -> dict[str, str]:
    """Return ``{issue key: summary}`` for every issue in the project.

    Pages through Jira Cloud's JQL search, ``GET /rest/api/3/search/jql``,
    following the ``nextPageToken`` it returns until there is none.
    ``credential`` is Jira Cloud's basic-auth credential, base64 of the
    account's ``email:api-token``: the form nightlydigest's
    ``jira-api-token`` secret is kept in, sent as it is. Blocking; callers
    run it in a thread.
    """
    names: dict[str, str] = {}
    headers = {"Accept": "application/json", "Authorization": f"Basic {credential}"}
    params: dict[str, str | int] = {
        "jql": f'project = "{project_key}" ORDER BY key',
        "fields": "summary",
        "maxResults": page_size,
    }
    search = f"{base_url.rstrip('/')}/rest/api/3/search/jql"
    while True:
        req = Request(f"{search}?{urlencode(params)}", headers=headers)
        try:
            with urlopen(req, timeout=timeout) as resp:
                page = json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            raise JiraError(f"Jira HTTP {exc.code}: {exc.reason}") from exc
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            raise JiraError(f"Jira unreachable: {exc}") from exc
        if not isinstance(page, dict):
            raise JiraError("Jira returned an unexpected page")
        for issue in page.get("issues") or []:
            fields = issue.get("fields") if isinstance(issue, dict) else None
            summary = fields.get("summary") if isinstance(fields, dict) else None
            if summary and issue.get("key"):
                names[str(issue["key"])] = str(summary).strip()
        nxt = page.get("nextPageToken")
        if page.get("isLast", True) or not nxt:
            return names
        params["nextPageToken"] = str(nxt)


class BlockNameService:
    """Serve the block names, refreshing from Zephyr and Jira when configured.

    The two sources name different keys (``BLOCK-T123`` test cases and
    ``BLOCK-123`` issues) and are fetched independently: one failing keeps
    its last names, and says why in ``error``, without holding up the other.
    """

    def __init__(
        self,
        snapshot: dict[str, str],
        *,
        zephyr_url: str | None = None,
        zephyr_token: str | None = None,
        jira_url: str | None = None,
        jira_credential: str | None = None,
        project_key: str = "BLOCK",
        refresh_interval: float = 86400.0,
    ) -> None:
        self._names = dict(snapshot)
        self.source = "snapshot"
        self.updated_at: datetime | None = None
        self.error: str | None = None
        self._zephyr_url = zephyr_url
        self._token = zephyr_token
        self._jira_url = jira_url
        # Base64 wrapped over lines (GNU base64's default) is still one.
        self._jira_credential = "".join((jira_credential or "").split()) or None
        self._identity: dict[str, dict[str, str]] = {"zephyr": {}, "jira": {}}
        if zephyr_token:
            self._identity["zephyr"] = token_identity(zephyr_token)
        if self._jira_credential:
            digest = hashlib.sha256(self._jira_credential.encode()).hexdigest()
            self._identity["jira"] = {
                "token_sha256": digest[:12],
                "jira": str(jira_url),
            }
            account = basic_account(self._jira_credential)
            if account:
                self._identity["jira"]["account"] = account
        self._fetched: set[str] = set()
        self._project = project_key
        self._interval = refresh_interval
        self._task: asyncio.Task[None] | None = None

    @property
    def names(self) -> dict[str, str]:
        return self._names

    def _sources(self) -> dict[str, Callable[[], dict[str, str]]]:
        """The configured sources by name, each as a blocking fetch."""
        sources: dict[str, Callable[[], dict[str, str]]] = {}
        if self._zephyr_url and self._token:
            sources["zephyr"] = partial(
                fetch_zephyr_names, self._zephyr_url, self._token, self._project
            )
        if self._jira_url and self._jira_credential:
            sources["jira"] = partial(
                fetch_jira_names, self._jira_url, self._jira_credential, self._project
            )
        return sources

    @property
    def refresh_enabled(self) -> bool:
        return bool(self._sources())

    def start(self) -> None:
        sources = self._sources()
        for name in ("zephyr", "jira"):
            if name not in sources:
                log.info(f"blocknames.{name}.disabled", reason="no token")
        if "jira" in sources and "account" not in self._identity["jira"]:
            # A bare API token, say: Jira will answer 401.
            log.warning(
                "blocknames.jira.credential_unrecognised",
                expected="base64 of email:api-token",
                **self._identity["jira"],
            )
        if sources:
            self._task = asyncio.create_task(self._loop(), name="block-names")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def refresh(self) -> bool:
        """Fetch from each configured source; ``True`` if any names changed.

        A fetch that comes back empty is treated as a failure: replacing a
        useful snapshot with nothing would blank every description over a
        transient API problem.
        """
        merged = dict(self._names)
        errors: list[str] = []
        applied = False
        for name, fetch in self._sources().items():
            identity = self._identity[name]
            try:
                fetched = await asyncio.to_thread(fetch)
            except BlockNamesError as exc:
                errors.append(str(exc))
                log.warning(
                    "blocknames.refresh.failed", source=name, error=str(exc), **identity
                )
                continue
            if not fetched:
                errors.append(
                    "Zephyr returned no test cases"
                    if name == "zephyr"
                    else "Jira returned no issues"
                )
                log.warning(
                    "blocknames.refresh.empty", source=name, project=self._project
                )
                continue
            # Keep keys the source no longer has: a test case or issue
            # deleted upstream may still name blocks already observed.
            merged.update(fetched)
            self._fetched.add(name)
            applied = True
            log.info(
                f"blocknames.{name}.connected",
                project=self._project,
                count=len(fetched),
                **identity,
            )
        self.error = "; ".join(errors) or None
        if not applied:
            return False
        self._names = merged
        self.source = "+".join(n for n in ("zephyr", "jira") if n in self._fetched)
        self.updated_at = datetime.now(UTC)
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

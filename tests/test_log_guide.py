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

"""The log guide against the code: every event the app logs is documented,
and the guide's catalogue lists none the app no longer logs."""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "python" / "lsst" / "ts" / "rubintv"
GUIDE = ROOT / "docs" / "log-guide.md"
# An event is documented in the log guide, or in the operator guide's
# section on a part of the app that lists its own.
DOCS = [GUIDE, ROOT / "docs" / "operator-guide.md"]

LEVELS = {"debug", "info", "warning", "error", "exception", "critical"}
EVENT = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+")


@dataclass(frozen=True)
class Event:
    name: str
    """As written: ``poll.scan``, or ``blocknames.{name}.connected``."""
    pattern: str
    """A regex the documented names it covers match."""
    where: str


def _is_log_method(node: ast.AST) -> bool:
    """``log.info``, ``structlog.get_logger(__name__).warning`` and so on."""
    return isinstance(node, ast.Attribute) and node.attr in LEVELS


def _event(arg: ast.expr, where: str) -> Event | None:
    """The event a log call's first argument names, if it names one. An
    f-string's placeholders match any one part of a name."""
    if isinstance(arg, ast.Constant):
        if not isinstance(arg.value, str):
            return None
        name = arg.value
        pattern = re.escape(name)
    elif isinstance(arg, ast.JoinedStr):
        name = pattern = ""
        for part in arg.values:
            if isinstance(part, ast.FormattedValue):
                name += "{" + ast.unparse(part.value) + "}"
                pattern += "[a-z0-9_]+"
            elif isinstance(part, ast.Constant):
                name += str(part.value)
                pattern += re.escape(str(part.value))
    else:
        return None
    template = re.sub(r"\{[^}]*\}", "x", name)
    return Event(name, pattern, where) if EVENT.fullmatch(template) else None


def logged_events() -> list[Event]:
    events = []
    for path in sorted(PACKAGE.rglob("*.py")):
        tree = ast.parse(path.read_text())
        # Names bound to a log method, as in
        # ``emit = log.info if touched else log.debug``.
        aliases = {
            target.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(_is_log_method(n) for n in ast.walk(node.value))
            for target in node.targets
            if isinstance(target, ast.Name)
        }
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            func = node.func
            if _is_log_method(func) or (
                isinstance(func, ast.Name) and func.id in aliases
            ):
                where = f"{path.relative_to(ROOT)}:{node.lineno}"
                if (event := _event(node.args[0], where)) is not None:
                    events.append(event)
    return events


def documented_names() -> set[str]:
    names: set[str] = set()
    for path in DOCS:
        for token in re.findall(r"`([a-z][a-z0-9_.]*)`", path.read_text()):
            if EVENT.fullmatch(token):
                names.add(token)
    return names


def catalogue() -> list[str]:
    """The event in the first column of each catalogue row."""
    text = GUIDE.read_text().split("\n## Catalogue\n", 1)[1]
    return re.findall(r"^\| `([^`]+)` \|", text, re.MULTILINE)


def test_the_scan_finds_every_way_the_app_logs() -> None:
    names = {e.name for e in logged_events()}
    # A plain call, one through a name bound to a log method, and one on a
    # logger that isn't the module's ``log``.
    assert {"startup.begin", "poll.scan", "logging.level.unknown"} <= names


def test_every_event_logged_is_documented() -> None:
    documented = documented_names()
    missing = sorted(
        {
            f"{e.name} ({e.where})"
            for e in logged_events()
            if not any(re.fullmatch(e.pattern, d) for d in documented)
        }
    )
    assert not missing, "add these to docs/log-guide.md:\n" + "\n".join(missing)


def test_every_catalogued_event_is_logged() -> None:
    rows = catalogue()
    assert len(rows) == len(set(rows)), "an event is catalogued twice"
    patterns = [e.pattern for e in logged_events()]
    stale = [r for r in rows if not any(re.fullmatch(p, r) for p in patterns)]
    assert not stale, "no longer logged; remove from docs/log-guide.md: " + ", ".join(
        stale
    )

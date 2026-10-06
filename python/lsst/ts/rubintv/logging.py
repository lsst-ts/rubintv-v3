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

"""structlog configuration.

JSON output in production, human-friendly output in development. Call
:func:`configure_logging` once at startup before anything logs.
"""

from __future__ import annotations

import logging
import sys

import structlog


def configure_logging(*, json_logs: bool, level: str = "INFO") -> None:
    """Configure structlog and the stdlib logging it wraps.

    Args:
        json_logs: Emit JSON (production) rather than a colourised console
            renderer (development).
        level: Root log level name, e.g. ``"INFO"``.
    """
    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]

    renderer: structlog.types.Processor
    if json_logs:
        # JSONRenderer does not render tracebacks itself: without this every
        # ``log.exception`` serialises as a bare ``"exc_info": true`` and the
        # actual error is lost. ConsoleRenderer formats exc_info on its own.
        shared_processors.append(structlog.processors.format_exc_info)
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer()

    # uvicorn (and run_rubintv's --log-level choices) accept "trace", but the
    # stdlib has no TRACE level — map it to DEBUG rather than KeyError-ing the
    # whole app at import time. Any other unknown name degrades to INFO with a
    # warning: a typo in RUBINTV_LOG_LEVEL must not crash-loop the pod exactly
    # when an operator is trying to turn logging up.
    name = level.upper()
    if name == "TRACE":
        name = "DEBUG"
    resolved = logging.getLevelNamesMapping().get(name)

    structlog.configure(
        processors=[*shared_processors, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.INFO if resolved is None else resolved
        ),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )
    if resolved is None:
        structlog.get_logger(__name__).warning(
            "logging.level.unknown", requested=level, using="INFO"
        )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Return a bound structlog logger."""
    logger: structlog.stdlib.BoundLogger = structlog.get_logger(name)
    return logger

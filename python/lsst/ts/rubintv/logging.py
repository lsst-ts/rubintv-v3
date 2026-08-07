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

    renderer: structlog.types.Processor = (
        structlog.processors.JSONRenderer()
        if json_logs
        else structlog.dev.ConsoleRenderer()
    )

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

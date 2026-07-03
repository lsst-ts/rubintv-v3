"""Console entry point: ``run_rubintv``.

Installed as a script by ``pyproject.toml``'s ``[project.scripts]`` and invoked
by the conda package, EUPS, and ``start-daemon.sh`` in the container — the same
launch path V2 uses, so deployment tooling needs no per-environment special
casing.
"""

from __future__ import annotations

import argparse
import os
import sys

import uvicorn

DEFAULT_PORT = 8000


def _port_from_env() -> int:
    """Listen port from ``$RUBINTV_PORT``, tolerating Kubernetes noise.

    When a Service named ``rubintv`` shares the pod's namespace, the
    kubelet injects docker-link-style variables — including
    ``RUBINTV_PORT=tcp://<cluster-ip>:<port>`` — which is service
    discovery, not our configuration. Treat anything that isn't a plain
    integer as unset rather than crash on startup.
    """
    raw = os.environ.get("RUBINTV_PORT", "")
    if not raw:
        return DEFAULT_PORT
    try:
        return int(raw)
    except ValueError:
        print(
            f"Ignoring non-numeric RUBINTV_PORT={raw!r} (Kubernetes "
            f"service link?); listening on {DEFAULT_PORT}.",
            file=sys.stderr,
        )
        return DEFAULT_PORT


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the RubinTV application.")
    parser.add_argument(
        "-l",
        "--log-level",
        default=os.environ.get("RUBINTV_LOG_LEVEL", "info").lower(),
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        help="uvicorn log level (default: info, or $RUBINTV_LOG_LEVEL).",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("RUBINTV_HOST", "0.0.0.0"),
        help="Bind host (default: 0.0.0.0, or $RUBINTV_HOST).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=_port_from_env(),
        help="Bind port (default: 8000, or $RUBINTV_PORT).",
    )
    return parser.parse_args(argv)


def run_rubintv(
    log_level: str = "info", host: str = "0.0.0.0", port: int = 8000
) -> None:
    # Import lazily so `--help` and entry-point resolution don't pay the
    # cost of building the app (and importing boto3, etc.).
    uvicorn.run(
        "lsst.ts.rubintv.main:app",
        host=host,
        port=port,
        log_level=log_level,
    )


def main() -> None:
    args = parse_args()
    run_rubintv(log_level=args.log_level, host=args.host, port=args.port)


if __name__ == "__main__":
    main()

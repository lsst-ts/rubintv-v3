"""Console entry point: ``run_rubintv``.

Installed as a script by ``pyproject.toml``'s ``[project.scripts]`` and invoked
by the conda package, EUPS, and ``start-daemon.sh`` in the container — the same
launch path V2 uses, so deployment tooling needs no per-environment special
casing.
"""

from __future__ import annotations

import argparse
import os

import uvicorn


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the RubinTV application.")
    parser.add_argument(
        "-l",
        "--log-level",
        default=os.environ.get("RUBINTV_LOG_LEVEL", "info").lower(),
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        help="uvicorn log level (default: info, or $RUBINTV_LOG_LEVEL).",
    )
    # Host and port are flags only, never environment variables. A
    # Kubernetes Service named rubintv makes the kubelet inject
    # RUBINTV_PORT=tcp://<cluster-ip>:<port> (docker service links) into
    # every pod in the namespace, so that name can never be trusted as
    # configuration; deployments pass --port explicitly (start.sh).
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="Bind host (default: 0.0.0.0).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Bind port (default: 8000).",
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

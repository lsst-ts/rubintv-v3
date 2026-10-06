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

_LOG_LEVELS = ["critical", "error", "warning", "info", "debug", "trace"]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the RubinTV application.")
    parser.add_argument(
        "-l",
        "--log-level",
        default=None,
        choices=_LOG_LEVELS,
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
    args = parser.parse_args(argv)
    # argparse never validates a default against choices, so an env-provided
    # level is applied (and checked) only when no -l flag was given —
    # otherwise a typo'd RUBINTV_LOG_LEVEL sails through and crashes deep
    # inside uvicorn.run instead of erroring here with usage.
    if args.log_level is None:
        env_level = os.environ.get("RUBINTV_LOG_LEVEL", "info").lower()
        if env_level not in _LOG_LEVELS:
            parser.error(
                f"$RUBINTV_LOG_LEVEL: invalid level {env_level!r} "
                f"(choose from {', '.join(_LOG_LEVELS)})"
            )
        args.log_level = env_level
    return args


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

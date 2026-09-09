"""run_rubintv entry point: host/port are flags only, never environment."""

from __future__ import annotations

import pytest
from lsst.ts.rubintv.run_rubintv import parse_args


def test_port_defaults_to_8000() -> None:
    assert parse_args([]).port == 8000


def test_env_rubintv_port_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    # RUBINTV_PORT belongs to Kubernetes: a Service named "rubintv" makes
    # the kubelet inject RUBINTV_PORT=tcp://<cluster-ip>:<port> into every
    # pod in the namespace, so the app must never read it — numeric or not.
    monkeypatch.setenv("RUBINTV_PORT", "tcp://10.106.28.210:8080")
    assert parse_args([]).port == 8000
    monkeypatch.setenv("RUBINTV_PORT", "9001")
    assert parse_args([]).port == 8000


def test_env_rubintv_host_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUBINTV_HOST", "10.0.0.7")
    assert parse_args([]).host == "0.0.0.0"


def test_port_and_host_flags_win(monkeypatch: pytest.MonkeyPatch) -> None:
    # The container entrypoint passes --port explicitly (start.sh); the
    # injected environment must not matter.
    monkeypatch.setenv("RUBINTV_PORT", "tcp://10.106.28.210:8080")
    args = parse_args(["--port", "8080", "--host", "127.0.0.1"])
    assert args.port == 8080
    assert args.host == "127.0.0.1"


def test_env_log_level_trace_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    # "trace" is an advertised choice (uvicorn accepts it); it must parse.
    monkeypatch.setenv("RUBINTV_LOG_LEVEL", "trace")
    assert parse_args([]).log_level == "trace"


def test_env_log_level_invalid_errors_cleanly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # argparse never validates defaults against choices, so a typo'd env
    # level must be caught explicitly — a clean usage error, not a KeyError
    # deep inside uvicorn.
    monkeypatch.setenv("RUBINTV_LOG_LEVEL", "verbose")
    with pytest.raises(SystemExit):
        parse_args([])


def test_log_level_flag_beats_bad_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUBINTV_LOG_LEVEL", "verbose")
    assert parse_args(["-l", "debug"]).log_level == "debug"


def test_configure_logging_accepts_trace() -> None:
    # The stdlib has no TRACE level; configure_logging must map it to DEBUG
    # rather than KeyError-ing app startup (CrashLoopBackOff when an operator
    # turns logging up).
    from lsst.ts.rubintv.logging import configure_logging

    configure_logging(json_logs=False, level="trace")
    configure_logging(json_logs=False, level="unknown-level")  # degrades to INFO
    configure_logging(json_logs=False, level="INFO")  # restore default

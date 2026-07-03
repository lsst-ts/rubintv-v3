"""run_rubintv entry point: port resolution under Kubernetes service links."""

from __future__ import annotations

import pytest
from lsst.ts.rubintv.run_rubintv import parse_args


def test_port_defaults_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RUBINTV_PORT", raising=False)
    assert parse_args([]).port == 8000


def test_port_honours_numeric_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUBINTV_PORT", "9001")
    assert parse_args([]).port == 9001


def test_port_ignores_kubernetes_service_link(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # A Service named "rubintv" in the pod's namespace makes the kubelet
    # inject RUBINTV_PORT=tcp://<cluster-ip>:<port>; startup must not crash.
    monkeypatch.setenv("RUBINTV_PORT", "tcp://10.106.28.210:8080")
    assert parse_args([]).port == 8000
    assert "Ignoring non-numeric RUBINTV_PORT" in capsys.readouterr().err


def test_port_flag_wins_over_garbage_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # The container entrypoint passes --port explicitly (start.sh), so the
    # injected variable must not even matter when the flag is given.
    monkeypatch.setenv("RUBINTV_PORT", "tcp://10.106.28.210:8080")
    assert parse_args(["--port", "8080"]).port == 8080

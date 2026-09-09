"""Health endpoint behaviour."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_live(client: TestClient) -> None:
    resp = client.get("/api/health/live")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "version" in body


def test_ready_when_app_assembled(client: TestClient) -> None:
    # The lifespan marks the app ready in Phase 1.
    resp = client.get("/api/health/ready")
    assert resp.status_code == 200
    assert resp.json() == {"ready": True}

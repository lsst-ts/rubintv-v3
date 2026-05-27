"""Shared test fixtures."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from rubintv.app import create_app
from rubintv.config.settings import Settings

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "models_data.yaml"


@pytest.fixture
def settings() -> Settings:
    """Settings pointed at the repo's sample config, no Redis, no cache."""
    return Settings(
        site="local",
        models_path=CONFIG_PATH,
        cache_dir=None,
        redis_url=None,
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    """A TestClient with the lifespan run (so app.state is assembled)."""
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client

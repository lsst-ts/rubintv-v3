"""uvicorn entrypoint.

Run with::

    uv run uvicorn rubintv.main:app --reload
"""

from __future__ import annotations

from rubintv.app import create_app

app = create_app()

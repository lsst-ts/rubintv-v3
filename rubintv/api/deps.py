"""FastAPI dependencies for reaching shared application state.

Handlers depend on these rather than touching ``request.app.state``
directly, so the wiring is typed and mockable in tests.
"""

from __future__ import annotations

from fastapi import Request

from rubintv.config.models import Models
from rubintv.state import AppState


def get_app_state(request: Request) -> AppState:
    """Return the assembled application state."""
    return request.app.state.app_state  # type: ignore[no-any-return]


def get_models(request: Request) -> Models:
    """Return the validated config model tree."""
    state: AppState = request.app.state.app_state
    return state.models
